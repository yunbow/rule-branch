from __future__ import annotations

from datetime import UTC, datetime, timedelta
import unittest

from rulebranch.compile_job import CompileJobHandler
from rulebranch.compiler import compile
from rulebranch.github_publisher import GitHubPublisher
from rulebranch.job_runtime import JobHandlerRegistry, WorkerRuntime
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext
from fake_firestore import InMemoryFirestore


class FakeGitData:
    """A Git Data double: blobs, trees, commits, refs, and draft PR state only."""
    def __init__(self) -> None:
        self.heads = {"main": "base"}; self.trees = {"base": {}}; self.opened = []; self.closed = []; self.prs = []; self.parents = []; self.ref_updates = []; self.blob_contents = []; self.seen_repositories = []
    def branch_head(self, repository, branch): self.seen_repositories.append(repository); return self.heads[branch]
    def tree(self, _repository, sha): return dict(self.trees[sha])
    def blob(self, _repository, content): self.blob_contents.append(content); return __import__("rulebranch.compiler", fromlist=["git_blob_sha"]).git_blob_sha(content)
    def read_blob(self, _repository, sha):
        return next(content for content in self.blob_contents if __import__("rulebranch.compiler", fromlist=["git_blob_sha"]).git_blob_sha(content) == sha)
    def new_tree(self, _repository, base, entries):
        value = dict(self.trees[base])
        for item in entries:
            if item["sha"] is None:
                if item["path"] not in value: raise ValueError("GitHub cannot delete an absent file")
                del value[item["path"]]
            else: value[item["path"]] = item["sha"]
        sha = f"tree-{len(self.trees)}"; self.trees[sha] = value; return sha
    def commit(self, _repository, tree, parent, _message):
        sha = f"commit-{len(self.trees)}"; self.trees[sha] = self.trees[tree]; self.parents.append(parent); return sha
    def ref(self, _repository, branch, sha, force): self.ref_updates.append(force); self.heads[branch] = sha
    def open_pull_request(self, _repository, _title, _body, _head, _base, draft):
        self.opened.append(draft); value = {"number": len(self.opened), "url": f"https://example/pr/{len(self.opened)}"}; self.prs.append(value); return value
    def edit_pull_request(self, _repository, _number, _body): pass
    def close_pull_request(self, _repository, number): self.closed.append(number)
    def find_open_pull_request(self, _repository, _head, _base): return self.prs[0] if self.prs else None


class CollisionStore(FirestoreRuleStore):
    def openRevisionPr(self, ctx, input):
        # Emulate a winner appearing after artifacts were batched but before the
        # revision transaction is entered; its target deliberately has no PR.
        self._firestore.put("unique_keys", f"revision_pr_open:{input['repositoryId']}", {"id": "racer", "ownerWorkspaceId": ctx.workspaceId, "targetId": "missing"})
        return super().openRevisionPr(ctx, input)


class CompileJobTests(unittest.TestCase):
    workspace, repository_id, project_id, rule_id, version_id = "ws-14", "repo-14", "project-14", "rule-14", "version-14"

    def seed(self, store, mock_resolver=True):
        store._firestore.put("projects", self.project_id, {"id": self.project_id, "ownerWorkspaceId": self.workspace, "status": "active", "deletedAt": None})
        db = store._firestore; ctx = RuleStoreContext(self.workspace, None, "ai")
        project = {"id": self.project_id, "ownerWorkspaceId": self.workspace, "status": "active", "deletedAt": None}
        repository = {"id": self.repository_id, "ownerWorkspaceId": self.workspace, "projectId": self.project_id, "installationId": "inst", "status": "active", "defaultBranch": "main", "compileTargets": ["agents-md", "rulebranch-rules"], "rulesPath": ".rulebranch/rules"}
        rule = {"id": self.rule_id, "ownerWorkspaceId": self.workspace, "projectId": self.project_id, "scopeType": "project", "scopeId": self.project_id, "key": "quality", "layer": "L2", "enforcement": "default", "selector": {}, "status": "active", "currentVersionId": self.version_id}
        version = {"id": self.version_id, "ownerWorkspaceId": self.workspace, "ruleId": self.rule_id, "status": "approved", "content": "Write tests", "version": 1}
        for collection, value in (("projects", project), ("repositories", repository), ("rules", rule), ("rule_versions", version)): db.put(collection, value["id"], value)
        snapshot = {"id": "snapshot-14", "ownerWorkspaceId": self.workspace, "projectId": self.project_id, "repositoryId": self.repository_id, "ruleVersionIds": [self.version_id], "conflicts": []}
        if mock_resolver:
            # Publication impact attribution reads the persisted snapshot, just as production does.
            db.put("resolution_snapshots", snapshot["id"], snapshot)
            store._resolve_rules = lambda *_args, **_kwargs: snapshot
        return ctx, repository, rule, version, snapshot

    def handler(self, store, api): return CompileJobHandler(store, GitHubPublisher(api))
    def job(self, **payload): return {"id": "job-14", "ownerWorkspaceId": self.workspace, "payload": {"repositoryId": self.repository_id, **payload}}

    def test_matching_default_tree_creates_nothing(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); _, repo, rule, version, snapshot = self.seed(store)
        outputs = compile({"resolutionSnapshot": snapshot, "rules": [rule], "ruleVersions": [version], "ruleRelations": [], "repository": repo})
        api.trees["base"] = {item.path: item.gitBlobSha for item in outputs}
        api.blob_contents.extend(item.publicationContent for item in outputs)
        created = store.createAnalysisJob(RuleStoreContext(self.workspace, None, "ai"), {"type": "compile", "projectId": self.project_id, "payload": {"repositoryId": self.repository_id}, "idempotencyKey": f"compile:{self.repository_id}:done", "requestId": "done"})["job"]
        registry = JobHandlerRegistry(); registry.register("compile", self.handler(store, api)); WorkerRuntime(store, object(), "unused", registry).run_job(self.workspace, created["id"])
        ctx = RuleStoreContext(self.workspace, None, "ai")
        self.assertEqual(store.get(ctx, "analysis_jobs", created["id"])["status"], "done"); self.assertEqual(store.list(ctx, "compiled_artifacts"), []); self.assertEqual(store.list(ctx, "revision_prs"), []); self.assertEqual(api.opened, [])

    def test_mismatch_persists_artifacts_and_opens_draft(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); self.seed(store)
        self.handler(store, api)(self.job(ruleVersionId=self.version_id), None)
        ctx = RuleStoreContext(self.workspace, None, "ai"); artifacts, prs = store.list(ctx, "compiled_artifacts"), store.list(ctx, "revision_prs")
        self.assertTrue(artifacts); self.assertEqual(len(prs), 1); self.assertTrue(prs[0]["isDraft"]); self.assertTrue(all(a["contentHash"] and a["gitBlobSha"] and a["revisionPrId"] and a["resolutionSnapshotId"] for a in artifacts)); self.assertEqual(next(a for a in artifacts if a["target"] == "rulebranch-rules")["ruleId"], self.rule_id)

    def test_compile_bulk_reads_only_versions_needed_by_snapshot(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); self.seed(store)
        for index in range(100):
            store._firestore.put("rule_versions", f"historical-{index}", {"id": f"historical-{index}", "ownerWorkspaceId": self.workspace, "ruleId": self.rule_id})
        original_list = store.list
        def guarded_list(ctx, collection, filter=None):
            if collection == "rule_versions": raise AssertionError("compile must not scan every historical rule version")
            if collection == "compiled_artifacts" and filter and "repositoryId" in filter: raise AssertionError("compile must not scan repository artifact history")
            return original_list(ctx, collection, filter)
        store.list = guarded_list  # type: ignore[method-assign]
        self.handler(store, api)(self.job(), None)
        self.assertEqual(store._firestore.get_all_calls, 1)

    def test_compile_scans_rules_and_relations_once_for_resolution_and_output(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); self.seed(store, mock_resolver=False)
        self.handler(store, api)(self.job(), None)
        self.assertEqual(store._firestore.query_calls.get("rules"), 1)
        self.assertEqual(store._firestore.query_calls.get("rule_relations"), 1)
        self.assertEqual(store._firestore.get_all_calls, 2)

    def test_compile_resolves_against_fresh_removed_repository(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, stale_repository, *_ = self.seed(store, mock_resolver=False)
        fresh_repository = {**stale_repository, "status": "removed"}
        store._firestore.put("repositories", self.repository_id, fresh_repository)
        self.handler(store, api)._compile_and_publish(ctx, self.job(), self.job()["payload"], stale_repository)
        snapshots = store.list(ctx, "resolution_snapshots", {"repositoryId": self.repository_id})
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["ruleVersionIds"], [])
        self.assertEqual(api.blob_contents, [])
        self.assertEqual(api.opened, [])

    def test_compile_uses_fresh_repository_metadata_for_publication(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, stale_repository, *_ = self.seed(store)
        fresh_repository = {**stale_repository, "fullName": "new-owner/new-name"}
        store._firestore.put("repositories", self.repository_id, fresh_repository)
        self.handler(store, api)._compile_and_publish(ctx, self.job(), self.job()["payload"], stale_repository)
        self.assertTrue(api.seen_repositories)
        self.assertTrue(all(value.get("fullName") == "new-owner/new-name" for value in api.seen_repositories))

    def test_deny_for_another_repository_does_not_leak_into_compiled_output(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repository, *_ = self.seed(store, mock_resolver=False)
        other_repository = {**repository, "id": "repo-other"}
        store._firestore.put("repositories", "repo-other", other_repository)
        parent = {"id": "parent", "ownerWorkspaceId": self.workspace, "projectId": None,
                  "scopeType": "organization", "scopeId": self.workspace, "key": "parent", "layer": "L2",
                  "enforcement": "default", "selector": {},
                  "status": "active", "currentVersionId": "parent-v"}
        child = {"id": "child", "ownerWorkspaceId": self.workspace, "projectId": self.project_id,
                 "scopeType": "project", "scopeId": self.project_id, "key": "child", "layer": "L2",
                 "enforcement": "default", "selector": {"repositoryIds": ["repo-other"]},
                 "status": "active", "currentVersionId": "child-v"}
        store._firestore.put("rules", "parent", parent); store._firestore.put("rules", "child", child)
        store._firestore.put("rule_versions", "parent-v", {"id": "parent-v", "ownerWorkspaceId": self.workspace, "ruleId": "parent", "status": "approved", "content": "secret parent"})
        store._firestore.put("rule_versions", "child-v", {"id": "child-v", "ownerWorkspaceId": self.workspace, "ruleId": "child", "status": "approved", "content": "other repository child"})
        store._firestore.put("rule_relations", "deny", {"id": "deny", "ownerWorkspaceId": self.workspace,
                                  "parentRuleId": "parent", "childRuleId": "child", "relationType": "deny",
                                  "rationale": "other repository only"})
        self.handler(store, api)(self.job(), None)
        published = "\n".join(api.blob_contents)
        self.assertNotIn("other repository only", published)
        self.assertIn("secret parent", published)
        self.assertFalse(any(path.endswith("_denied.md") for path in api.trees[api.heads["rulebranch/rules-update"]]))
        other_api = FakeGitData()
        other_job = {**self.job(), "payload": {"repositoryId": "repo-other"}}
        self.handler(store, other_api)(other_job, None)
        other_published = "\n".join(other_api.blob_contents)
        self.assertIn("other repository only", other_published)
        self.assertTrue(any(path.endswith("_denied.md") for path in other_api.trees[other_api.heads["rulebranch/rules-update"]]))

    def test_private_resolver_rejects_cross_tenant_project_and_repository(self):
        store = FirestoreRuleStore(InMemoryFirestore()); ctx, repository, *_ = self.seed(store, mock_resolver=False)
        project = {"id": self.project_id, "ownerWorkspaceId": self.workspace}
        for invalid_project, invalid_repository in (
            ({**project, "ownerWorkspaceId": "other"}, repository),
            (project, {**repository, "ownerWorkspaceId": "other"}),
            (project, {**repository, "projectId": "other"}),
        ):
            with self.assertRaisesRegex(Exception, "NOT_FOUND"):
                store._resolve_rules(ctx, self.project_id, self.repository_id, None, None,
                                     invalid_project, invalid_repository, [], [])

    def test_existing_draft_reuses_its_id_and_adds_commit(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); ctx, *_ = self.seed(store)
        api.heads["rulebranch/rules-update"] = "base"
        old = store.openRevisionPr(ctx, {"id": "old-pr", "ownerWorkspaceId": self.workspace, "projectId": self.project_id, "repositoryId": self.repository_id, "resolutionSnapshotId": "old", "prNumber": 77, "prUrl": "https://example/pr/77", "branch": "rulebranch/rules-update", "kind": "compile", "ruleVersionIds": [], "isDraft": True, "requestId": "old"})
        store._firestore.put("compiled_artifacts", "superseded-artifact", {"id": "superseded-artifact", "ownerWorkspaceId": self.workspace, "repositoryId": self.repository_id, "revisionPrId": old["id"], "resolutionSnapshotId": "old", "path": "AGENTS.md"})
        self.handler(store, api)(self.job(ruleVersionId=self.version_id), None)
        artifacts, prs = store.list(ctx, "compiled_artifacts"), store.list(ctx, "revision_prs")
        self.assertEqual(len(prs), 1); self.assertEqual(prs[0]["id"], old["id"]); self.assertEqual(api.opened, []); self.assertTrue(all(a["revisionPrId"] == old["id"] for a in artifacts))
        self.assertNotIn("superseded-artifact", {artifact["id"] for artifact in artifacts})
        self.assertEqual(api.parents, ["base"])
        self.assertEqual(api.ref_updates, [False])

        first_ids = {artifact["id"] for artifact in artifacts}
        self.handler(store, api)(self.job(ruleVersionId=self.version_id), None)
        retried = store.list(ctx, "compiled_artifacts")
        self.assertEqual(len(retried), len(artifacts))
        self.assertTrue(first_ids.isdisjoint({artifact["id"] for artifact in retried}))

    def test_k9_kind_and_unique_collision_closes_new_pr_and_leaves_orphans_unreferenced(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); ctx, _, _, version, _ = self.seed(store); handler = self.handler(store, api)
        self.assertEqual(handler._kind(ctx, self.version_id, False), "compile")
        store._firestore.put("rule_versions", "old-approved", {**version, "id": "old-approved", "status": "approved"})
        self.assertEqual(handler._kind(ctx, self.version_id, False), "proposal"); self.assertEqual(handler._kind(ctx, self.version_id, True), "compile")
        collision, collision_api = CollisionStore(InMemoryFirestore()), FakeGitData(); self.seed(collision)
        with self.assertRaises(Exception): self.handler(collision, collision_api)(self.job(ruleVersionId=self.version_id), None)
        orphan_ids = {a["revisionPrId"] for a in collision.list(ctx, "compiled_artifacts")}; pr_ids = {p["id"] for p in collision.list(ctx, "revision_prs")}
        self.assertEqual(collision_api.closed, [1]); self.assertTrue(orphan_ids.isdisjoint(pr_ids))

    def test_repository_lease_rejects_parallel_compile_and_is_released(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); ctx, *_ = self.seed(store)
        repository = store.get(ctx, "repositories", self.repository_id) or {}
        repository["compileLease"] = {"owner": "other", "jobId": "other-job", "expiresAt": (datetime.now(UTC) + timedelta(minutes=5)).isoformat()}
        store._firestore.put("repositories", self.repository_id, repository)
        with self.assertRaisesRegex(Exception, "COMPILE_LEASED"):
            self.handler(store, api)(self.job(), None)
        self.assertEqual(api.opened, [])
        repository["compileLease"]["expiresAt"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        store._firestore.put("repositories", self.repository_id, repository)
        self.handler(store, api)(self.job(), None)
        self.assertIsNone(store.get(ctx, "repositories", self.repository_id).get("compileLease"))

    def test_large_artifact_and_obsolete_path_are_published_correctly(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData(); ctx, repo, rule, version, _ = self.seed(store)
        version["content"] = "x" * (200 * 1024 + 1); store._firestore.put("rule_versions", self.version_id, version)
        api.trees["base"][".rulebranch/rules/L3/obsolete.md"] = "old"
        store._firestore.put("revision_prs", "old", {"id": "old", "ownerWorkspaceId": self.workspace, "repositoryId": self.repository_id, "status": "merged", "mergedAt": "2025-01-01T00:00:00+00:00"})
        store._firestore.put("compiled_artifacts", "old-artifact", {"id": "old-artifact", "ownerWorkspaceId": self.workspace, "projectId": self.project_id, "repositoryId": self.repository_id, "revisionPrId": "old", "resolutionSnapshotId": "old-snapshot", "path": ".rulebranch/rules/L3/obsolete.md"})
        self.handler(store, api)(self.job(), None)
        head = api.heads["rulebranch/rules-update"]
        self.assertNotIn(".rulebranch/rules/L3/obsolete.md", api.trees[head])
        draft = next(pr for pr in store.list(ctx, "revision_prs") if pr["status"] == "draft_open")
        self.assertEqual(draft["expectedDeletedPaths"],
                         [".rulebranch/rules/L3/obsolete.md"])
        self.assertTrue(any(len(content.encode()) > 200 * 1024 for content in api.blob_contents))
        self.assertTrue(any(item["contentOmitted"] and item["content"] is None for item in store.list(ctx, "compiled_artifacts", {"resolutionSnapshotId": "snapshot-14"})))

    def test_previously_deleted_obsolete_file_does_not_block_new_publication(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, *_ = self.seed(store)
        store._firestore.put("revision_prs", "old", {"id":"old", "ownerWorkspaceId":self.workspace, "repositoryId":self.repository_id, "status":"merged", "mergedAt":"2026-01-01"})
        store._firestore.put("compiled_artifacts", "gone", {"id":"gone", "ownerWorkspaceId":self.workspace, "revisionPrId":"old", "path":".rulebranch/rules/L3/removed.md"})
        self.handler(store, api)(self.job(), None)
        self.assertEqual(api.opened, [True])
        self.assertNotIn(".rulebranch/rules/L3/removed.md", api.trees[api.heads["rulebranch/rules-update"]])
        self.assertEqual(store.list(ctx, "revision_prs")[-1]["expectedDeletedPaths"],
                         [".rulebranch/rules/L3/removed.md"])
        # Updating an existing draft must not lose historical deletion expectations.
        self.handler(store, api)(self.job(), None)
        self.assertEqual(store.list(ctx, "revision_prs")[-1]["expectedDeletedPaths"],
                         [".rulebranch/rules/L3/removed.md"])


    def test_shared_instruction_file_preserves_manual_text_and_exact_stored_hash(self):
        from rulebranch.compiler import git_blob_sha
        from rulebranch.managed_instructions import BEGIN
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repo, rule, version, snapshot = self.seed(store)
        manual = "# Team rules\r\nUse pnpm.\r\n"
        api.trees["base"]["AGENTS.md"] = api.blob(repo, manual)
        self.handler(store, api)(self.job(), None)
        artifact = next(a for a in store.list(ctx, "compiled_artifacts") if a["path"] == "AGENTS.md")
        self.assertTrue(artifact["content"].startswith(manual))
        self.assertEqual(artifact["gitBlobSha"], git_blob_sha(artifact["content"]))
        version["content"] = "Write regression tests"; store._firestore.put("rule_versions", self.version_id, version)
        self.handler(store, api)(self.job(), None)
        updated = next(a for a in store.list(ctx, "compiled_artifacts") if a["path"] == "AGENTS.md")
        self.assertTrue(updated["content"].startswith(manual))
        self.assertEqual(updated["content"].count(BEGIN), 1)
        self.assertNotIn("Write tests", updated["content"])

    def test_recompile_rebaselines_manual_instruction_edit_without_empty_pr(self):
        from rulebranch.managed_instructions import update_instructions
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repo, rule, version, snapshot = self.seed(store)
        repo["compileTargets"] = ["agents-md"]
        store._firestore.put("repositories", self.repository_id, repo)
        output = compile({"resolutionSnapshot": snapshot, "rules": [rule],
                          "ruleVersions": [version], "ruleRelations": [], "repository": repo})[0]
        current_content = update_instructions("# Manual notes\nDo not delete me.\n", output.publicationContent)
        api.trees["base"]["AGENTS.md"] = api.blob(repo, current_content)
        store._firestore.put("revision_prs", "merged", {"id":"merged", "ownerWorkspaceId":self.workspace,
                "projectId":self.project_id, "repositoryId":self.repository_id,
                "status":"merged", "mergedAt":"2026-10-10T00:00:00Z", "prNumber":1, "resolutionSnapshotId":"prior"})
        store._firestore.put("compiled_artifacts", "stale", {"id":"stale", "ownerWorkspaceId":self.workspace,
                "revisionPrId":"merged", "resolutionSnapshotId":"prior", "target":"agents-md",
                "path":"AGENTS.md", "gitBlobSha":"old-blob"})
        self.handler(store, api)(self.job(), None)
        revision = store.get(ctx, "revision_prs", "merged")
        self.assertEqual(revision["verification"]["state"], "verified")
        self.assertEqual(revision["resolutionSnapshotId"], snapshot["id"])
        self.assertEqual(api.opened, [])
        saved = store.list(ctx, "compiled_artifacts", {"revisionPrId":"merged"})
        self.assertEqual(len(saved),1)
        self.assertEqual(saved[0]["gitBlobSha"], api.trees["base"]["AGENTS.md"])
        self.assertEqual(saved[0]["commitSha"], "base")

    def test_rebaseline_keeps_deleted_paths_and_refuses_resurrected_files(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repo, rule, version, snapshot = self.seed(store)
        expected_deleted = ".rulebranch/rules/L3/retired.md"
        outputs = compile({"resolutionSnapshot": snapshot, "rules": [rule],
                           "ruleVersions": [version], "ruleRelations": [], "repository": repo})
        for item in outputs:
            api.trees["base"][item.path] = api.blob(repo, item.publicationContent)
        store._firestore.put("revision_prs", "merged", {
            "id": "merged", "ownerWorkspaceId": self.workspace,
            "projectId": self.project_id, "repositoryId": self.repository_id,
            "resolutionSnapshotId": "old", "status": "merged",
            "mergedAt": "2026-01-01", "prNumber": 1,
            "expectedDeletedPaths": [expected_deleted],
        })
        self.handler(store, api)(self.job(), None)
        pr = store.get(ctx, "revision_prs", "merged")
        self.assertEqual(pr["expectedDeletedPaths"], [expected_deleted])
        self.assertEqual(pr["verification"]["state"], "verified")
        api.trees["base"][expected_deleted] = "reintroduced"
        with self.assertRaisesRegex(ValueError, "Previously deleted RuleBranch paths reappeared"):
            self.handler(store, api)(self.job(), None)
        self.assertEqual(store.get(ctx, "revision_prs", "merged")["verification"]["state"], "verified")
        self.assertEqual(api.opened, [])

    def test_disabled_aggregate_target_removes_only_owned_section(self):
        from rulebranch.managed_instructions import BEGIN
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repo, *_ = self.seed(store)
        api.trees["base"]["AGENTS.md"] = api.blob(repo, "# Manual rules\n")
        self.handler(store, api)(self.job(), None)
        repo["compileTargets"] = ["rulebranch-rules"]; store._firestore.put("repositories", self.repository_id, repo)
        self.handler(store, api)(self.job(), None)
        artifact = next(a for a in store.list(ctx, "compiled_artifacts") if a["path"] == "AGENTS.md")
        self.assertEqual(artifact["content"], "# Manual rules\n\n")
        self.assertNotIn(BEGIN, artifact["content"])

    def test_verified_legacy_file_is_migrated_without_duplicate_rules(self):
        from rulebranch.compiler import HEADER
        from rulebranch.managed_instructions import BEGIN
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        ctx, repo, *_ = self.seed(store)
        legacy = HEADER + "\n\nOld generated rules\n"
        old_sha = api.blob(repo, legacy); api.trees["base"]["AGENTS.md"] = old_sha
        store._firestore.put("revision_prs", "old", {"id":"old","ownerWorkspaceId":self.workspace,"repositoryId":self.repository_id,"status":"merged","mergedAt":"2026-01-01"})
        store._firestore.put("compiled_artifacts", "old-a", {"id":"old-a","ownerWorkspaceId":self.workspace,"revisionPrId":"old","path":"AGENTS.md","target":"agents-md","gitBlobSha":old_sha})
        self.handler(store, api)(self.job(), None)
        artifact = next(a for a in store.list(ctx, "compiled_artifacts") if a.get("revisionPrId") != "old" and a["path"] == "AGENTS.md")
        self.assertIn(BEGIN, artifact["content"]); self.assertNotIn("Old generated rules", artifact["content"])

    def test_branch_change_aborts_before_writing_blobs(self):
        store, api = FirestoreRuleStore(InMemoryFirestore()), FakeGitData()
        self.seed(store)
        original = api.branch_head
        calls = 0
        def changed(repo, branch):
            nonlocal calls
            calls += 1
            return original(repo, branch) if calls == 1 else "new-main"
        api.branch_head = changed
        with self.assertRaisesRegex(ValueError, "branch changed"):
            self.handler(store, api)(self.job(), None)
        self.assertEqual(api.blob_contents, [])
