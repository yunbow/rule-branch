"""Deterministic compile job with serialized, retry-safe GitHub publication."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from dataclasses import replace
from hashlib import sha256
from typing import Any

from .compiler import compile, CompiledArtifact, MAX_ARTIFACT_CONTENT_BYTES, git_blob_sha
from .execution_guard import compile_ownership
from .managed_instructions import INSTRUCTION_PATHS, update_instructions
from .github_publisher import BRANCH, GitHubPublisher
from .rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError
from .ulid import generate_ulid

COMPILE_LEASE_DURATION = timedelta(minutes=15)


class CompileJobHandler:
    def __init__(self, store: FirestoreRuleStore, publisher: GitHubPublisher) -> None: self.store, self.publisher = store, publisher

    def __call__(self, job: dict[str, Any], _directory: Any) -> dict[str, Any]:
        ctx = RuleStoreContext(str(job["ownerWorkspaceId"]), None, "ai")
        payload = dict(job.get("payload") or {}); repository_id = str(payload["repositoryId"])
        lease_owner = generate_ulid()
        repository = self._acquire_lease(ctx, repository_id, lease_owner, str(job.get("id", lease_owner)))
        try:
            with compile_ownership(self.store, ctx.workspaceId, repository_id, lease_owner):
                return self._compile_and_publish(ctx, job, payload, repository)
        finally:
            self._release_lease(ctx, repository_id, lease_owner)

    def _compile_and_publish(self, ctx: RuleStoreContext, job: dict[str, Any], payload: dict[str, Any], repository: dict[str, Any]) -> dict[str, Any]:
        repository_id = str(repository["id"])
        fresh_repository = self.store.get(ctx, "repositories", repository_id)
        project_id = str((fresh_repository or repository)["projectId"])
        project = self.store.get(ctx, "projects", project_id)
        # Unlink does not take the compile lease.  It can therefore win after
        # lease acquisition; record the empty resolution, but never publish to
        # a repository whose fresh source-of-truth status is removed.
        if fresh_repository is not None and fresh_repository.get("status") == "removed":
            self.store._resolve_rules(ctx, project_id, repository_id, None, None,
                                      project, fresh_repository, [], [])
            return {"success": True}
        # Repository metadata such as the default branch and full name can be
        # updated independently of the compile lease.  Use the same fresh
        # document for resolution, compilation, and every GitHub call.
        if fresh_repository is not None:
            repository = fresh_repository
        rules = self.store.list(ctx, "rules"); relations = self.store.list(ctx, "rule_relations")
        snapshot = self.store._resolve_rules(ctx, project_id, repository_id, None, None,
                                             project, fresh_repository, rules, relations)
        rules_by_id = {str(rule["id"]): rule for rule in rules}
        version_ids = [str(value) for value in snapshot.get("ruleVersionIds", [])]
        denied_child_version_ids = {
            str(value.get("ruleVersionId")) for value in snapshot.get("resolvedRules", [])
            if isinstance(value, dict) and value.get("resolvedVia") == "deny"
        }
        denied_child_ids = {
            rule_id for rule_id, rule in rules_by_id.items()
            if str(rule.get("currentVersionId", "")) in denied_child_version_ids
        }
        version_ids.extend(
            str(rules_by_id[parent]["currentVersionId"])
            for relation in relations
            if relation.get("relationType") == "deny"
            and str(relation.get("childRuleId", "")) in denied_child_ids
            and (parent := str(relation.get("parentRuleId", ""))) in rules_by_id
            and isinstance(rules_by_id[parent].get("currentVersionId"), str)
        )
        version_ids = list(dict.fromkeys(version_ids))
        versions = self.store._get_many(ctx, "rule_versions", version_ids)
        artifacts = compile({"resolutionSnapshot": snapshot, "rules": rules, "ruleVersions": versions, "ruleRelations": relations, "repository": repository})
        revisions = self.store.list(ctx, "revision_prs", {"repositoryId": repository_id})
        existing = next((value for value in revisions if value.get("status") == "draft_open"), None)
        # Recover BEFORE publication_snapshot/update_instructions: the remote
        # draft may contain human edits that were never recorded in Firestore.
        if existing is None:
            recovered = self.publisher.recover_open(repository)
            if recovered is not None:
                existing = {**recovered, "id": generate_ulid(), "repositoryId": repository_id,
                            "projectId": project_id, "ownerWorkspaceId": ctx.workspaceId}
        # Only one revision can describe the branch we are diffing: the open PR
        # head, or otherwise the latest merged state on the default branch.
        # Scanning every historical artifact makes compile cost grow forever.
        latest_merged = max(
            (value for value in revisions if value.get("status") == "merged"),
            key=lambda value: (str(value.get("mergedAt") or ""), str(value.get("id") or "")),
            default=None,
        )
        baseline = existing or latest_merged
        # Deletion expectations survive draft updates and later compilations.
        # Otherwise removing the last generated file would become unobservable.
        expected_deleted: set[str] = set()
        for prior in (latest_merged, existing):
            if prior and isinstance(prior.get("expectedDeletedPaths"), list):
                expected_deleted.update(
                    path for path in prior["expectedDeletedPaths"]
                    if isinstance(path, str) and path
                )
        prior_artifacts = self.store.list(ctx, "compiled_artifacts", {"revisionPrId": str(baseline["id"])}) if baseline else []
        desired_paths = {item.path for item in artifacts}
        obsolete_paths = sorted({str(item["path"]) for item in prior_artifacts if isinstance(item.get("path"), str)} - desired_paths)
        expected_head, current = self.publisher.publication_snapshot(repository, existing)
        prior_by_path = {str(item["path"]): item for item in prior_artifacts}
        prepared = []
        for item in artifacts:
            if item.path in INSTRUCTION_PATHS and item.path in current:
                old = self.publisher.read_blob(repository, current[item.path])
                if git_blob_sha(old) != current[item.path]: raise ValueError("Instruction blob hash mismatch")
                content = update_instructions(old, item.publicationContent,
                    legacy_owned=current[item.path] == prior_by_path.get(item.path, {}).get("gitBlobSha"))
                item = self._with_content(item, content)
            prepared.append(item)
        # Removing a target removes only our block, never a shared manual file.
        deletions = []
        for path in obsolete_paths:
            if path not in current:
                expected_deleted.add(path)
                continue
            if path not in INSTRUCTION_PATHS:
                expected_deleted.add(path)
                deletions.append(path)
                continue
            old = self.publisher.read_blob(repository, current[path])
            if git_blob_sha(old) != current[path]: raise ValueError("Instruction blob hash mismatch")
            remaining = update_instructions(old, "", legacy_owned=current[path] == prior_by_path.get(path, {}).get("gitBlobSha"))
            if not remaining.strip():
                expected_deleted.add(path)
                deletions.append(path)
            else:
                prior = prior_by_path[path]
                item = CompiledArtifact(str(prior["target"]), path, "", None, False, "", None)
                prepared.append(self._with_content(item, remaining))
        artifacts, obsolete_paths = prepared, deletions
        expected_deleted.difference_update(item.path for item in artifacts)
        expected_deleted_paths = sorted(expected_deleted)
        # Never attest a clean baseline while a previously deleted managed path
        # has reappeared. Do not silently remove newly authored manual files.
        unexpected_paths = sorted(path for path in expected_deleted_paths if path in current and path not in obsolete_paths)
        if unexpected_paths:
            raise ValueError(f"Previously deleted RuleBranch paths reappeared: {', '.join(unexpected_paths[:10])}")
        changed = any(current.get(item.path) != item.gitBlobSha for item in artifacts) or any(path in current for path in obsolete_paths)
        revision_id = generate_ulid(); now = datetime.now(UTC).isoformat()
        # If the default branch already contains the approved managed block,
        # an existing merged PR can be re-verified without inventing an empty PR.
        artifact_revision_id = str(existing["id"]) if existing else (
            str(baseline["id"]) if not changed and baseline and baseline.get("status") == "merged" else revision_id
        )
        docs = [{"id": generate_ulid(), "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": repository["projectId"], "visibility": "private", "enforcement": None, "transferPolicy": "project-only", "licenseType": "proprietary-customer", "provenance": {"sourceType": "system", "sourceRef": snapshot["id"], "derivedFromCustomerCode": False}, "containsPersonalData": False, "containsConfidentialData": item.path in INSTRUCTION_PATHS, "retentionClass": "standard", "createdBy": {"kind": "ai", "id": "worker"}, "createdAt": now, "updatedAt": now, "deletedAt": None, "projectId": repository["projectId"], "repositoryId": repository_id, "resolutionSnapshotId": snapshot["id"], "target": item.target, "path": item.path, "contentHash": item.contentHash, "content": item.content, "contentOmitted": item.contentOmitted, "gitBlobSha": item.gitBlobSha, "ruleId": item.ruleId, "revisionPrId": artifact_revision_id, "commitSha": None, "publishedAt": None, "compilerVersion": item.compilerVersion, "generatedAt": now} for item in artifacts]
        if not changed and existing is None:
            if baseline and baseline.get("status") == "merged":
                # A human edit outside the managed instruction block changes
                # the whole-file blob hash. Recompilation preserving that edit
                # must refresh the verified baseline rather than remain mismatch.
                if self.publisher._api.branch_head(repository, str(repository["defaultBranch"])) != expected_head:
                    raise ValueError("Default branch changed during publication reconciliation")
                for doc in docs:
                    doc["commitSha"], doc["publishedAt"] = expected_head, now
                self.store.writeCompiledArtifacts(ctx, docs)
                self._rebaseline_merged(ctx, baseline, snapshot, repository, docs, expected_head, now, expected_deleted_paths)
                self.store.pruneCompiledArtifacts(ctx, artifact_revision_id, {str(doc["id"]) for doc in docs})
            return {"success": True}
        trigger = payload.get("ruleVersionId"); trigger_ids = [str(trigger)] if trigger else []
        publication_artifacts = [{"path": item.path, "publicationContent": item.publicationContent, "gitBlobSha": item.gitBlobSha} for item in artifacts]
        published = self.publisher.publish(repository, publication_artifacts, trigger_ids, existing, obsolete_paths, expected_head=expected_head)
        # Persist only after GitHub accepted the exact bytes.  A retry can
        # recover an unrecorded remote PR by its fixed head branch.
        self.store.writeCompiledArtifacts(ctx, docs)
        record = {"id": str(existing["id"]) if existing else revision_id, "ownerWorkspaceId": ctx.workspaceId, "projectId": repository["projectId"], "repositoryId": repository_id, "resolutionSnapshotId": snapshot["id"], "prNumber": published.number, "prUrl": published.url, "branch": BRANCH, "kind": self._kind(ctx, trigger, bool(payload.get("manual"))), "ruleVersionIds": trigger_ids, "expectedDeletedPaths": expected_deleted_paths, "status": "draft_open", "isDraft": True, "requestId": str(job.get("id", revision_id))}
        try:
            self.store.openRevisionPr(ctx, record)
        except Exception:
            if existing is None and published.created: self.publisher._api.close_pull_request(repository, published.number)
            raise
        # revision_prs.resolutionSnapshotId is the commit point.  Once it has
        # advanced, older generations for this same open draft cannot be used
        # by publication verification and only inflate future reads/storage.
        self.store.pruneCompiledArtifacts(ctx, artifact_revision_id, {str(doc["id"]) for doc in docs})
        return {"success": True}

    def _rebaseline_merged(self, ctx: RuleStoreContext, baseline: dict[str, Any], snapshot: dict[str, Any],
                           repository: dict[str, Any], artifacts: list[dict[str, Any]],
                           sha: str, now: str, expected_deleted_paths: list[str]) -> None:
        """No Git diff: atomically attest the recomputed bytes and resolve only
        the artifact-mismatch findings for this specific repository."""
        pr_id = str(baseline["id"])
        all_prs = self.store.list(ctx, "revision_prs", {"repositoryId": str(repository["id"])})
        verification = {"state": "verified", "checkedCommitSha": sha, "checkedAt": now,
                        "reason": "recompile", "mismatchedPaths": []}
        def write(tx: Any) -> None:
            pr_ref = self.store._ref("revision_prs", pr_id)
            current_prs = [tx.get(self.store._ref("revision_prs", str(pr["id"]))).to_dict() for pr in all_prs]
            newest = max((pr for pr in current_prs if pr and pr.get("status") == "merged"),
                         key=lambda pr: (str(pr.get("mergedAt") or ""), int(pr.get("prNumber") or 0)),
                         default=None)
            current = next((pr for pr in current_prs if pr and pr["id"] == pr_id), None)
            if (not current or current.get("ownerWorkspaceId") != ctx.workspaceId
                    or current.get("status") != "merged" or not newest or newest["id"] != pr_id
                    or current.get("resolutionSnapshotId") != baseline.get("resolutionSnapshotId")):
                raise RuleStoreError("PUBLICATION_CHANGED", 409)
            tx.update(pr_ref, {"resolutionSnapshotId": snapshot["id"],
                               "expectedDeletedPaths": expected_deleted_paths, "verification": verification})
            self.store.appendAuditLog(ctx, {"actor": {"kind": "system", "id": "rule-compiler"},
                "action": "pr.publish_verified", "targetType": "revision_prs", "targetId": pr_id,
                "requestId": f"recompile:{pr_id}:{sha}", "after": verification}, tx)
        self.store.runTransaction(write)
        # Reuse the verifier's bounded, retry-safe reconciliation. The verified
        # marker above is its durable resume point.
        from .publish_verify import PublishVerifyJobHandler
        updated = {**baseline, "resolutionSnapshotId": snapshot["id"],
                   "expectedDeletedPaths": expected_deleted_paths, "verification": verification}
        current_prs = [updated if item.get("id") == pr_id else item for item in all_prs]
        PublishVerifyJobHandler(self.store, None)._resolve_verified_findings(  # type: ignore[arg-type]
            ctx, repository, artifacts, now, updated, current_prs, sha)

    @staticmethod
    def _with_content(item: CompiledArtifact, content: str) -> CompiledArtifact:
        omitted = len(content.encode("utf-8")) > MAX_ARTIFACT_CONTENT_BYTES
        return replace(item, contentHash=sha256(content.encode("utf-8")).hexdigest(),
                       gitBlobSha=git_blob_sha(content), content=None if omitted else content,
                       contentOmitted=omitted, publicationContent=content)

    def _acquire_lease(self, ctx: RuleStoreContext, repository_id: str, owner: str, job_id: str) -> dict[str, Any]:
        now = datetime.now(UTC); expires_at = now + COMPILE_LEASE_DURATION
        def acquire(tx: Any) -> dict[str, Any]:
            ref = self.store._ref("repositories", repository_id); snap = tx.get(ref); repository = snap.to_dict()
            if not snap.exists or not repository or repository.get("ownerWorkspaceId") != ctx.workspaceId or repository.get("status") != "active":
                raise RuleStoreError("NOT_FOUND", 404)
            lease = repository.get("compileLease")
            if isinstance(lease, dict) and lease.get("owner") != owner:
                try: active_until = datetime.fromisoformat(str(lease["expiresAt"]))
                except (KeyError, TypeError, ValueError): active_until = now
                if active_until.tzinfo is None: active_until = active_until.replace(tzinfo=UTC)
                if active_until > now: raise RuleStoreError("COMPILE_LEASED", 409, {"repositoryId": repository_id})
            tx.update(ref, {"compileLease": {"owner": owner, "jobId": job_id, "expiresAt": expires_at.isoformat()}})
            return repository
        return self.store.runTransaction(acquire)

    def _release_lease(self, ctx: RuleStoreContext, repository_id: str, owner: str) -> None:
        def release(tx: Any) -> None:
            ref = self.store._ref("repositories", repository_id); snap = tx.get(ref); repository = snap.to_dict()
            if not snap.exists or not repository or repository.get("ownerWorkspaceId") != ctx.workspaceId: return
            lease = repository.get("compileLease")
            if isinstance(lease, dict) and lease.get("owner") == owner: tx.update(ref, {"compileLease": None})
        self.store.runTransaction(release)

    def _kind(self, ctx: RuleStoreContext, version_id: object, manual: bool) -> str:
        if manual or not version_id: return "compile"
        version = self.store.get(ctx, "rule_versions", str(version_id))
        if not version: return "compile"
        prior = [item for item in self.store.list(ctx, "rule_versions", {"ruleId": version["ruleId"]}) if item.get("id") != version_id and item.get("status") == "approved"]
        return "proposal" if prior else "compile"

