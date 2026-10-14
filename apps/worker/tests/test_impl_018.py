from __future__ import annotations
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from rulebranch.purge import PurgeJobHandler
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext

class Impl018Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db, self.store, self.ctx = InMemoryFirestore(), None, RuleStoreContext("w", None, "system")
        self.store = FirestoreRuleStore(self.db)
    def put(self, table: str, id: str, **data: object) -> None: self.db.put(table, id, {"id": id, **data})
    def test_purge_deletes_all_customer_tables_redacts_and_is_idempotent(self) -> None:
        self.put("workspaces", "w", kind="organization", status="deleted", deletedAt="t")
        for table in ("installations", "projects", "repositories", "rules", "rule_versions", "rule_checks", "drift_findings", "evidence", "usage_provenance", "compiled_artifacts", "impact_reports", "pr_review_comments", "decision_memories", "rule_relations", "change_triggers", "resolution_snapshots", "revision_prs", "analysis_jobs"):
            self.put(table, table, ownerWorkspaceId="w", status="deleted", deletedAt="t")
        self.put("workspace_members", "m", workspaceId="w"); self.put("workspace_invitations", "v", workspaceId="w")
        self.put("unique_keys", "github_org:1", kind="github_org", ownerWorkspaceId=None, targetTable="workspaces", targetId="w")
        self.put("unique_keys", "project_slug:w:p", kind="project_slug", ownerWorkspaceId="w", targetTable="projects", targetId="projects")
        self.store.appendAuditLog(self.ctx, {"actor": {"kind": "system", "id": "x"}, "action": "installation.delete", "targetType": "installations", "targetId": "installations", "requestId": "r", "before": {"pii": 1}})
        first = self.store.purgeWorkspace(self.ctx, "w"); second = self.store.purgeWorkspace(self.ctx, "w")
        self.assertGreater(first["deletedCount"], 0); self.assertEqual(second["deletedCount"], 0)
        for table in ("projects", "repositories", "rules", "workspace_members", "workspace_invitations", "installations"): self.assertEqual(self.db.query(table, []), [])
        audit = self.db.query("audit_logs", [])[0].to_dict(); self.assertIsNone(audit["before"]); self.assertIsNone(audit["after"]); self.assertIsNotNone(audit["payloadRedactedAt"]); self.assertIsNone(self.db.get("unique_keys", "github_org:1")[0])
    def test_reinstall_cancels_only_matching_tombstone(self) -> None:
        self.put("workspaces", "w", kind="organization", status="deleted", deletedAt="same")
        self.put("installations", "old", ownerWorkspaceId="w", status="deleted", deletedAt="same", purgeScheduledAt="later")
        self.put("installations", "new", ownerWorkspaceId="w", status="active", deletedAt=None)
        self.put("rules", "restore", ownerWorkspaceId="w", deletedAt="same"); self.put("rules", "keep", ownerWorkspaceId="w", deletedAt="older")
        result = PurgeJobHandler(self.store)({"ownerWorkspaceId": "w", "payload": {}}, Path("/tmp"))
        self.assertTrue(result["cancelled"]); self.assertIsNone(self.db.get("rules", "restore")[0]["deletedAt"]); self.assertEqual(self.db.get("rules", "keep")[0]["deletedAt"], "older")
        self.assertEqual(self.db.get("workspaces", "w")[0]["status"], "active")
        self.assertIsNone(self.db.get("workspaces", "w")[0]["deletedAt"])
        self.assertEqual(self.db.get("installations", "old")[0]["status"], "deleted")
        self.assertEqual(self.db.get("installations", "old")[0]["deletedAt"], "same")

    def test_subject_purge_releases_identity_keys_and_personal_workspace(self) -> None:
        self.put("users", "u", githubUserId="github-u", personalWorkspaceId="personal", login="octo")
        self.put("user_preferences", "preference", userId="u")
        self.put("workspaces", "personal", kind="personal")
        self.put("workspace_members", "personal-member", workspaceId="personal", userId="u")
        self.put("workspace_members", "organization-member", workspaceId="organization", userId="u")
        self.put("workspaces", "organization", kind="organization")
        self.put("projects", "personal-project", ownerWorkspaceId="personal", slug="p")
        self.put("projects", "org-project", ownerWorkspaceId="organization", slug="op")
        self.put("unique_keys", "github_user:github-u", kind="github_user", ownerWorkspaceId=None, targetTable="users", targetId="u")
        self.put("unique_keys", "user_preference:u", kind="user_preference", ownerWorkspaceId=None, targetTable="user_preferences", targetId="preference")
        self.put("unique_keys", "workspace_member:personal:u", kind="workspace_member", ownerWorkspaceId="personal", targetTable="workspace_members", targetId="personal-member")
        self.put("unique_keys", "workspace_member:organization:u", kind="workspace_member", ownerWorkspaceId="organization", targetTable="workspace_members", targetId="organization-member")
        # Pending invitation addressed to the deleted account: nobody can ever accept
        # it once the account is gone, so it should be removed outright.
        self.put("workspace_invitations", "pending-for-u", workspaceId="organization", invitedGithubUserId="github-u", invitedGithubLogin="octo", status="pending", invitedByUserId="someone-else", acceptedByUserId=None)
        self.put("unique_keys", "workspace_invitation_pending:organization:github-u", kind="workspace_invitation_pending", ownerWorkspaceId="organization", targetTable="workspace_invitations", targetId="pending-for-u")
        # Invitations the deleted user sent or accepted: kept for the other party's
        # history, but the deleted user's identity is anonymized out of them.
        self.put("workspace_invitations", "sent-by-u", workspaceId="organization", invitedGithubUserId="other-github", invitedGithubLogin="other", status="pending", invitedByUserId="u", acceptedByUserId=None)
        self.put("workspace_invitations", "accepted-by-u", workspaceId="organization", invitedGithubUserId="github-u", invitedGithubLogin="octo", status="accepted", invitedByUserId="someone-else", acceptedByUserId="u")

        PurgeJobHandler(self.store)({"id": "purge-job", "ownerWorkspaceId": "w", "payload": {"subject": "u"}}, Path("/tmp"))

        self.assertIsNone(self.db.get("workspace_invitations", "pending-for-u")[0])
        self.assertIsNone(self.db.get("unique_keys", "workspace_invitation_pending:organization:github-u")[0])
        sent = self.db.get("workspace_invitations", "sent-by-u")[0]; self.assertIsNotNone(sent); self.assertIsNone(sent["invitedByUserId"])
        accepted = self.db.get("workspace_invitations", "accepted-by-u")[0]; self.assertIsNotNone(accepted); self.assertIsNone(accepted["acceptedByUserId"]); self.assertIsNone(accepted["invitedGithubLogin"]); self.assertIsNone(accepted["invitedGithubUserId"])

        # Account deletion is global: membership in every Workspace is gone, including
        # Organization Workspaces the deleted user never owned, so the same GitHub
        # account can freely rejoin later without a leftover unique key blocking it.
        for table, id in (("users", "u"), ("user_preferences", "preference"), ("workspaces", "personal"), ("workspace_members", "personal-member"), ("workspace_members", "organization-member"), ("projects", "personal-project"), ("unique_keys", "github_user:github-u"), ("unique_keys", "user_preference:u"), ("unique_keys", "workspace_member:personal:u"), ("unique_keys", "workspace_member:organization:u")):
            self.assertIsNone(self.db.get(table, id)[0])
        # The Organization itself and its content are untouched -- only the
        # deleted user's membership in it is gone.
        self.assertIsNotNone(self.db.get("workspaces", "organization")[0]); self.assertIsNotNone(self.db.get("projects", "org-project")[0])

        self.store.runTransaction(lambda tx: self.store.reserveUniqueKey(tx, "github_user", {"githubUserId": "github-u"}, {"targetTable": "users", "targetId": "new-u"}))
        self.assertIsNotNone(self.db.get("unique_keys", "github_user:github-u")[0])
        self.store.runTransaction(lambda tx: self.store.reserveUniqueKey(tx, "workspace_member", {"workspaceId": "organization", "userId": "u"}, {"targetTable": "workspace_members", "targetId": "new-member"}))
        self.assertIsNotNone(self.db.get("unique_keys", "workspace_member:organization:u")[0])

    def test_purge_preserves_its_own_job_record(self) -> None:
        # An installation-purge job whose Workspace it is itself purging (typical:
        # ownerWorkspaceId == the Workspace being torn down) must not delete its own
        # analysis_jobs record mid-sweep -- a crash right after would otherwise leave
        # the deletion half-finished with no job left for any retry/reconciler to find.
        self.put("workspaces", "w", kind="organization", status="deleted", deletedAt="t")
        self.put("analysis_jobs", "this-job", ownerWorkspaceId="w", type="purge", status="running")
        self.put("analysis_jobs", "other-job", ownerWorkspaceId="w", type="bootstrap", status="done")
        PurgeJobHandler(self.store)({"id": "this-job", "ownerWorkspaceId": "w", "payload": {}}, Path("/tmp"))
        self.assertIsNotNone(self.db.get("analysis_jobs", "this-job")[0])
        self.assertIsNone(self.db.get("analysis_jobs", "other-job")[0])

    def test_subject_purge_of_own_personal_workspace_preserves_its_own_job_record(self) -> None:
        # Same hazard as above, but reached via _subject's personal-Workspace
        # purgeWorkspace call: the deletion request can target the user's own
        # Personal Workspace, so the purge job's ownerWorkspaceId equals the
        # personalWorkspaceId being torn down.
        self.put("users", "u", personalWorkspaceId="personal", login="octo")
        self.put("workspaces", "personal", kind="personal")
        self.put("analysis_jobs", "this-job", ownerWorkspaceId="personal", type="purge", status="running")
        self.put("analysis_jobs", "other-job", ownerWorkspaceId="personal", type="bootstrap", status="done")
        PurgeJobHandler(self.store)({"id": "this-job", "ownerWorkspaceId": "personal", "payload": {"subject": "u"}}, Path("/tmp"))
        self.assertIsNotNone(self.db.get("analysis_jobs", "this-job")[0])
        self.assertIsNone(self.db.get("analysis_jobs", "other-job")[0])
        self.assertIsNone(self.db.get("workspaces", "personal")[0])

if __name__ == "__main__": unittest.main()
