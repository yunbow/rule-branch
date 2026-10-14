"""Deterministic default-branch artifact verification (IMPL-015)."""
from __future__ import annotations
from datetime import UTC, datetime
from typing import Any, Protocol
from .rulestore import FirestoreRuleStore, RuleStoreContext, DocumentData
from .ulid import generate_ulid
from .artifact_impacts import artifact_impacts

class GitTreeApi(Protocol):
    def branch_head(self, repository: DocumentData, branch: str) -> str: ...
    def tree(self, repository: DocumentData, commit_sha: str) -> tuple[dict[str, str], bool]: ...
    def contents_tree(self, repository: DocumentData, commit_sha: str) -> dict[str, str]: ...

class PublishVerifyJobHandler:
    def __init__(self, store: FirestoreRuleStore, git: GitTreeApi) -> None: self.store, self.git = store, git
    def __call__(self, job: DocumentData, _directory: Any) -> DocumentData:
        ctx = RuleStoreContext(str(job["ownerWorkspaceId"]), None, "system"); payload = dict(job.get("payload") or {})
        revision_id, repository_id, commit_sha = str(payload["revisionPrId"]), str(payload["repositoryId"]), str(payload["commitSha"])
        pr = self.store.get(ctx, "revision_prs", revision_id); repository = self.store.get(ctx, "repositories", repository_id)
        if not pr or not repository or pr.get("status") != "merged": return {"success": True}
        if pr.get("repositoryId") != repository_id or pr.get("projectId") != repository.get("projectId"):
            raise ValueError("publish verification repository mismatch")
        prs = self.store.list(ctx, "revision_prs", {"repositoryId": repository_id})
        if not self._is_latest(pr, prs): return {"success": True}
        # The queued SHA is an event hint, not the current default-branch state.
        # Delayed Cloud Tasks can otherwise verify an older, clean commit after a
        # newer mismatching commit and incorrectly clear its findings.
        branch = str(repository.get("defaultBranch") or "main")
        commit_sha = self.git.branch_head(repository, branch)
        verification = pr.get("verification")
        if isinstance(verification, dict) and verification.get("checkedCommitSha") == commit_sha and (verification.get("state") == "verified" or verification.get("state") == "mismatch" and verification.get("findingsComplete") is True):
            if verification["state"] == "mismatch":
                return {"success": True}
            artifacts = [a for a in self.store.list(ctx, "compiled_artifacts", {"revisionPrId": revision_id}) if a.get("resolutionSnapshotId") == pr.get("resolutionSnapshotId")]
            self._resolve_verified_findings(ctx, repository, artifacts, datetime.now(UTC).isoformat(), pr, prs, commit_sha)
            return {"success": True}
        # Revisit cached mismatch results: an interrupted bounded batch may
        # still need to create findings. Existing open findings are reused.
        tree, truncated = self.git.tree(repository, commit_sha)
        if truncated: tree = self.git.contents_tree(repository, commit_sha)
        # Never persist a tree which ceased to be HEAD while GitHub was read.
        # A transient failure makes Cloud Tasks retry against the new HEAD.
        if self.git.branch_head(repository, branch) != commit_sha:
            raise RuntimeError("Default branch advanced during publication verification")
        prs = self.store.list(ctx, "revision_prs", {"repositoryId": repository_id})
        if not self._is_latest(pr, prs): return {"success": True}
        artifacts = [a for a in self.store.list(ctx, "compiled_artifacts", {"revisionPrId": revision_id}) if a.get("resolutionSnapshotId") == pr.get("resolutionSnapshotId")]
        mismatch = [a for a in artifacts if tree.get(str(a["path"])) != a.get("gitBlobSha")]
        generated_paths = {str(a["path"]) for a in artifacts}
        raw_deleted_paths = pr.get("expectedDeletedPaths")
        deleted_paths = {path for path in raw_deleted_paths if isinstance(path, str)} if isinstance(raw_deleted_paths, list) else set()
        unexpectedly_present = sorted((deleted_paths - generated_paths) & tree.keys())
        now, reason = datetime.now(UTC).isoformat(), str(payload.get("reason", "pr_merged"))
        if not mismatch and not unexpectedly_present:
            for start in range(0, len(artifacts), 450):
                def write(tx: Any, batch=artifacts[start:start + 450]) -> None:
                    for artifact in batch: tx.update(self.store._ref("compiled_artifacts", str(artifact["id"])), {"commitSha": commit_sha, "publishedAt": now})
                self.store.runTransaction(write)
            verification = {"state": "verified", "checkedCommitSha": commit_sha, "checkedAt": now, "reason": reason, "mismatchedPaths": []}
            def record(tx: Any) -> bool:
                if not self._latest_in_transaction(tx, pr, prs): return False
                tx.update(self.store._ref("revision_prs", revision_id), {"verification": verification})
                return True
            if not self.store.runTransaction(record): return {"success": True}
            self._resolve_verified_findings(ctx, repository, artifacts, now, pr, prs, commit_sha)
            self.store.appendAuditLog(ctx, {"actor": {"kind": "system", "id": "publish-verifier"}, "action": "pr.publish_verified", "targetType": "revision_prs", "targetId": revision_id, "requestId": f"publish-verify:{revision_id}:{commit_sha}", "after": verification})
            return {"success": True}
        impacts = artifact_impacts(self.store, ctx, pr, mismatch)
        all_paths = sorted({str(item["path"]) for item in mismatch} | set(unexpectedly_present))
        # Aggregates may reference hundreds of rules. Do not silently stop at
        # fifty impacts; bound each transaction instead. Empty snapshots still
        # retain a repository verification mismatch without inventing a rule.
        for start in range(0, max(1, len(impacts)), 20):
            self._record_mismatch(ctx, pr, repository, commit_sha, reason, impacts[start:start + 20], tree, now, prs, all_paths)
        def complete(tx: Any) -> None:
            if not self._latest_in_transaction(tx, pr, prs):
                return
            ref = self.store._ref("revision_prs", revision_id)
            current = (tx.get(ref).to_dict() or {}).get("verification") or {}
            if current.get("state") == "mismatch" and current.get("checkedCommitSha") == commit_sha:
                tx.update(ref, {"verification": {**current, "findingsComplete": True}})
        self.store.runTransaction(complete)
        return {"success": True}
    def _record_mismatch(self, ctx: RuleStoreContext, pr: DocumentData, repository: DocumentData, sha: str, reason: str, mismatch: list[DocumentData], tree: dict[str, str], now: str, prs: list[DocumentData], all_paths: list[str] | None = None) -> None:
        kept = mismatch[:50]
        observed_paths = all_paths if all_paths is not None else sorted({str(a["path"]) for a in mismatch})
        paths = observed_paths[:50]
        trigger_id = generate_ulid(); existing = self.store.list(ctx, "drift_findings")
        triggers = {str(item["id"]): item for item in self.store.list(ctx, "change_triggers", {"projectId": repository["projectId"]})}
        def write(tx: Any) -> bool:
            if not self._latest_in_transaction(tx, pr, prs): return False
            rule_snapshots = {
                str(artifact["ruleId"]): tx.get(self.store._ref("rules", str(artifact["ruleId"])))
                for artifact in kept if artifact.get("ruleId")
            }
            verification: DocumentData = {"state": "mismatch", "checkedCommitSha": sha, "checkedAt": now, "reason": reason, "mismatchedPaths": paths}
            if len(observed_paths) > 50: verification["truncation"] = {"mismatchedPaths": {"total": len(observed_paths), "kept": 50}}
            tx.update(self.store._ref("revision_prs", str(pr["id"])), {"verification": verification})
            trigger: DocumentData = {"id": trigger_id, "ownerWorkspaceId": ctx.workspaceId, "projectId": repository["projectId"], "type": "compiled_artifact_mismatch", "source": {"repositoryId": repository["id"], "commitSha": sha, "prNumber": pr.get("prNumber"), "url": pr.get("prUrl"), "paths": sorted({str(item["path"]) for item in kept}) or paths}, "detectedAt": now, "detectedBy": {"kind": "system", "id": "publish-verifier"}, "processedAt": None, "resultingFindingIds": [], "truncation": None}
            ids: list[str] = []
            for artifact in kept:
                rule_id = artifact.get("ruleId")
                if not rule_id: continue
                rule = rule_snapshots[str(rule_id)].to_dict() or {}
                expected_version = artifact.get("ruleVersionId") or rule.get("currentVersionId")
                prior = next((f for f in existing
                    if f.get("ruleId") == rule_id and f.get("driftType") == "artifact_mismatch"
                    and f.get("ruleVersionId") == expected_version
                    and f.get("status") in {"open", "accepted"}
                    and (f.get("repositoryId") or (triggers.get(str(f.get("triggerId"))) or {}).get("source", {}).get("repositoryId")) == repository["id"]
                    and (not f.get("path") or f.get("path") == artifact["path"])), None)
                if prior: ids.append(str(prior["id"])); continue
                evidence_id, finding_id, path = generate_ulid(), generate_ulid(), str(artifact["path"]); actual = tree.get(path)
                evidence = {"id": evidence_id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": repository["projectId"], "visibility": "private", "enforcement": None, "transferPolicy": "prohibited", "licenseType": "proprietary-customer", "provenance": {"sourceType": "system", "sourceRef": sha, "derivedFromCustomerCode": False}, "containsPersonalData": False, "containsConfidentialData": True, "retentionClass": "evidence", "createdBy": {"kind": "system", "id": "publish-verifier"}, "createdAt": now, "updatedAt": now, "deletedAt": None, "kind": "commit", "repositoryId": repository["id"], "ref": {"commitSha": sha, "path": path, "url": pr.get("prUrl")}, "label": f"{path} @ {sha[:7]}", "excerpt": None, "excerptHash": None, "excerptLineCount": None, "excerptBytes": None, "excerptState": "none", "excerptPurgedAt": None, "capturedAt": now}
                finding = {"id": finding_id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": repository["projectId"], "visibility": "private", "enforcement": None, "transferPolicy": "project-only", "licenseType": "proprietary-customer", "provenance": {"sourceType": "system", "sourceRef": sha, "derivedFromCustomerCode": False}, "containsPersonalData": False, "containsConfidentialData": False, "retentionClass": "standard", "createdBy": {"kind": "system", "id": "publish-verifier"}, "createdAt": now, "updatedAt": now, "deletedAt": None, "ruleId": rule_id, "repositoryId": repository["id"], "path": path, "projectId": repository["projectId"], "ruleVersionId": artifact.get("ruleVersionId") or (rule_snapshots[str(rule_id)].to_dict() or {}).get("currentVersionId"), "triggerId": trigger_id, "driftType": "artifact_mismatch", "severity": "medium", "confidence": 1.0, "summary": f"生成物 {path} が default branch 上で RuleBranch の生成内容と一致しません(commit {sha[:7]})", "detail": f"期待 gitBlobSha: {artifact['gitBlobSha']}、実際の blob sha: {actual}、参照 URL: {pr.get('prUrl')}", "evidenceIds": [evidence_id], "provenanceIds": [], "status": "open", "triagedBy": None, "triagedAt": None, "dismissReason": None, "resolvedByRuleVersionId": None, "resolvedAt": None, "reopenCount": 0, "proposalVersionId": None, "truncation": None}
                tx.create(self.store._ref("evidence", evidence_id), evidence); tx.create(self.store._ref("drift_findings", finding_id), finding); ids.append(finding_id)
                if rule and rule.get("status") in {"active", "stale"} and rule.get("currentVersionId") == finding["ruleVersionId"]: tx.update(self.store._ref("rules", str(rule_id)), {"status": "stale", "staleSince": rule.get("staleSince") or now, "updatedAt": now})
            trigger["resultingFindingIds"] = ids[:200]
            if len(ids) > 200: trigger["truncation"] = {"resultingFindingIds": {"total": len(ids), "kept": 200}}
            tx.create(self.store._ref("change_triggers", trigger_id), trigger)
            return True
        if not self.store.runTransaction(write): return
        self.store.appendAuditLog(ctx, {"actor": {"kind": "system", "id": "publish-verifier"}, "action": "pr.publish_mismatch", "targetType": "revision_prs", "targetId": str(pr["id"]), "requestId": f"publish-verify:{pr['id']}:{sha}", "after": {"state": "mismatch", "mismatchedPaths": paths}})

    @staticmethod
    def _is_latest(pr: DocumentData, prs: list[DocumentData]) -> bool:
        merged = [item for item in prs if item.get("status") == "merged"]
        latest = max(merged, key=lambda item: (str(item.get("mergedAt") or ""), int(item.get("prNumber") or 0)), default=None)
        return latest is not None and latest["id"] == pr["id"]

    def _latest_in_transaction(self, tx: Any, pr: DocumentData, prs: list[DocumentData]) -> bool:
        # Include drafts so reconciliation while the GitHub tree is fetched causes
        # a retry instead of persisting an obsolete comparison.
        current = [tx.get(self.store._ref("revision_prs", str(item["id"]))).to_dict() for item in prs]
        actual = next((item for item in current if item and item.get("id") == pr.get("id")), None)
        return (actual is not None and actual.get("resolutionSnapshotId") == pr.get("resolutionSnapshotId")
                and self._is_latest(pr, [item for item in current if item]))

    def _resolve_verified_findings(self, ctx: RuleStoreContext, repository: DocumentData, artifacts: list[DocumentData], now: str, pr: DocumentData, prs: list[DocumentData], sha: str) -> None:
        paths = {str(item["path"]) for item in artifacts}
        artifact_rule_ids = {item["ruleId"] for item in artifact_impacts(self.store, ctx, pr, artifacts)}
        findings = self.store.list(ctx, "drift_findings")
        triggers = {item["id"]: item for item in self.store.list(ctx, "change_triggers", {"projectId": repository["projectId"]})}
        resolved = [item for item in findings if item.get("driftType") == "artifact_mismatch"
                    and item.get("status") in {"open", "accepted"}
                    and item.get("ruleId") in artifact_rule_ids
                    and (item.get("repositoryId") or triggers.get(item.get("triggerId"), {}).get("source", {}).get("repositoryId")) == repository["id"]
                    and (item.get("path") in paths if item.get("path") else
                         bool(triggers.get(item.get("triggerId"), {}).get("source", {}).get("paths"))
                         and set(triggers[item["triggerId"]]["source"]["paths"]) <= paths)]
        # Resolve in bounded, idempotent batches. A verified marker is written
        # before this method, so a crash resumes here through the cached-result
        # path without fetching GitHub again.
        for start in range(0, len(resolved), 100):
            batch = resolved[start:start + 100]
            def resolve(tx: Any, values=batch) -> None:
                if not self._latest_in_transaction(tx, pr, prs): return
                verification = (tx.get(self.store._ref("revision_prs", str(pr["id"]))).to_dict() or {}).get("verification") or {}
                if verification.get("state") != "verified" or verification.get("checkedCommitSha") != sha: return
                current = {str(item["id"]): tx.get(self.store._ref("drift_findings", str(item["id"]))).to_dict() for item in values}
                rule_ids = {str(item.get("ruleId")) for item in current.values() if item}
                rules = {rule_id: tx.get(self.store._ref("rules", rule_id)).to_dict() for rule_id in rule_ids}
                for finding_id, finding in current.items():
                    if finding and finding.get("status") in {"open", "accepted"}:
                        rule = rules.get(str(finding.get("ruleId"))) or {}
                        tx.update(self.store._ref("drift_findings", finding_id), {"status": "resolved", "resolvedAt": now, "resolvedByRuleVersionId": rule.get("currentVersionId"), "updatedAt": now})
            self.store.runTransaction(resolve)

        # Recompute each impacted Rule after all resolution batches. Query only
        # current pending findings inside the transaction; closed history is
        # irrelevant, and a finding inserted after the preload is still seen.
        groups: list[list[str]] = []
        group: list[str] = []
        for rule_id in sorted(str(value) for value in artifact_rule_ids):
            if group and len(group) >= 50:
                groups.append(group); group = []
            group.append(rule_id)
        if group: groups.append(group)
        for group in groups:
            def activate(tx: Any, values=group) -> None:
                if not self._latest_in_transaction(tx, pr, prs): return
                verification = (tx.get(self.store._ref("revision_prs", str(pr["id"]))).to_dict() or {}).get("verification") or {}
                if verification.get("state") != "verified" or verification.get("checkedCommitSha") != sha: return
                rules = {identifier: tx.get(self.store._ref("rules", identifier)).to_dict() for identifier in values}
                pending = {identifier: any(tx.query("drift_findings", {
                    "ownerWorkspaceId": ctx.workspaceId, "ruleId": identifier, "status": status}, limit=1)
                    for status in ("open", "accepted")) for identifier in values}
                for identifier in values:
                    rule = rules.get(identifier)
                    if rule and rule.get("status") == "stale" and not pending[identifier]:
                        tx.update(self.store._ref("rules", identifier), {"status": "active", "staleSince": None, "updatedAt": now})
            self.store.runTransaction(activate)
