"""Global GitHub reservations must be deleted atomically with purge targets."""
import unittest
from pathlib import Path

from rulebranch.purge import PurgeJobHandler
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext
from tests.fake_firestore import InMemoryFirestore


class PurgeGlobalKeyTests(unittest.TestCase):
    workspace = "purge-ws"
    ctx = RuleStoreContext(workspace, None, "system")

    @staticmethod
    def put_key(db, kind, identifier, target_table, target_id):
        db.put("unique_keys", f"{kind}:{identifier}", {
            "id": f"{kind}:{identifier}", "kind": kind, "ownerWorkspaceId": None,
            "targetTable": target_table, "targetId": target_id,
        })

    def setup_store(self):
        db = InMemoryFirestore()
        db.put("workspaces", self.workspace, {
            "id": self.workspace, "kind": "organization", "ownerWorkspaceId": self.workspace,
            "status": "deleted",
        })
        db.put("repositories", "repo", {
            "id": "repo", "ownerWorkspaceId": self.workspace, "projectId": "project",
        })
        db.put("installations", "installation", {
            "id": "installation", "ownerWorkspaceId": self.workspace,
        })
        self.put_key(db, "github_repo", "123", "repositories", "repo")
        self.put_key(db, "github_installation", "456", "installations", "installation")
        self.put_key(db, "github_org", "789", "workspaces", self.workspace)
        db.put("repositories", "foreign", {
            "id": "foreign", "ownerWorkspaceId": "another-workspace",
        })
        self.put_key(db, "github_repo", "other", "repositories", "foreign")
        return db, FirestoreRuleStore(db)

    def test_crash_after_repo_commit_does_not_strand_global_keys(self):
        db, store = self.setup_store()
        original = store.runTransaction
        crashed = False

        def fail_after_repository_commit(callback):
            nonlocal crashed
            value = original(callback)
            if not crashed and not db.snapshot("repositories", "repo").exists:
                crashed = True
                raise RuntimeError("injected process loss after repository batch commit")
            return value

        store.runTransaction = fail_after_repository_commit
        with self.assertRaisesRegex(RuntimeError, "injected process loss"):
            store.purgeWorkspace(self.ctx, self.workspace)
        store.runTransaction = original

        self.assertFalse(db.snapshot("repositories", "repo").exists)
        self.assertFalse(db.snapshot("unique_keys", "github_repo:123").exists)
        store.purgeWorkspace(self.ctx, self.workspace)
        for collection, identifier in (
            ("installations", "installation"),
            ("unique_keys", "github_installation:456"),
            ("workspaces", self.workspace),
            ("unique_keys", "github_org:789"),
        ):
            self.assertFalse(db.snapshot(collection, identifier).exists, (collection, identifier))
        self.assertTrue(db.snapshot("repositories", "foreign").exists)
        self.assertTrue(db.snapshot("unique_keys", "github_repo:other").exists)

    def test_bounded_batches_count_key_deletions_against_firestore_limit(self):
        db, store = self.setup_store()
        for index in range(240):
            id = f"repo-{index}"
            db.put("repositories", id, {"id": id, "ownerWorkspaceId": self.workspace})
            self.put_key(db, "github_repo", f"bulk-{index}", "repositories", id)
        store.purgeWorkspace(self.ctx, self.workspace)
        self.assertFalse(db.snapshot("unique_keys", "github_repo:bulk-239").exists)
        self.assertFalse(db.snapshot("repositories", "repo-239").exists)

    def test_active_reinstall_cancels_before_marker_but_marker_retry_resumes(self):
        db, store = self.setup_store()
        db.put("installations", "replacement", {
            "id": "replacement", "ownerWorkspaceId": self.workspace, "status": "active",
        })
        cancelled = store.purgeWorkspace(self.ctx, self.workspace)
        self.assertTrue(cancelled["cancelled"])
        self.assertIsNone(db.snapshot("workspaces", self.workspace).to_dict().get("purgeStartedAt"))
        self.assertTrue(db.snapshot("installations", "replacement").exists)

        workspace = db.snapshot("workspaces", self.workspace).to_dict()
        db.put("workspaces", self.workspace, {**workspace, "purgeStartedAt": "earlier"})
        resumed = store.purgeWorkspace(self.ctx, self.workspace)
        self.assertNotIn("cancelled", resumed)
        self.assertFalse(db.snapshot("installations", "replacement").exists)

    def test_personal_workspace_purge_is_not_cancelled_by_active_installation(self):
        db = InMemoryFirestore()
        db.put("workspaces", "personal", {"id": "personal", "kind": "personal", "status": "active"})
        db.put("installations", "active", {
            "id": "active", "ownerWorkspaceId": "personal", "status": "active",
        })
        result = FirestoreRuleStore(db).purgeWorkspace(
            RuleStoreContext("personal", None, "system"), "personal")
        self.assertNotIn("cancelled", result)
        self.assertFalse(db.snapshot("installations", "active").exists)

    def test_handler_resumes_marker_even_when_active_installation_exists(self):
        db, store = self.setup_store()
        workspace = db.snapshot("workspaces", self.workspace).to_dict()
        db.put("workspaces", self.workspace, {**workspace, "purgeStartedAt": "earlier"})
        db.put("installations", "replacement", {
            "id": "replacement", "ownerWorkspaceId": self.workspace, "status": "active",
        })
        result = PurgeJobHandler(store)({
            "id": "purge-job", "ownerWorkspaceId": self.workspace, "payload": {},
        }, Path("/tmp"))
        self.assertNotIn("cancelled", result)
        self.assertFalse(db.snapshot("installations", "replacement").exists)


if __name__ == "__main__":
    unittest.main()
