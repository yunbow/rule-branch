"""UC-06 and data-subject purge job handler."""
from __future__ import annotations
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from .rulestore import UNINSTALL_TOMBSTONE_TABLES, FirestoreRuleStore, RuleStoreContext, TransactionLike, sha256HexString

GOV_AND_CONTENT = ("installations", "workspaces", *UNINSTALL_TOMBSTONE_TABLES)

class PurgeJobHandler:
    def __init__(self, store: FirestoreRuleStore) -> None: self.store = store
    def _delete_and_release(self, collection: str, doc_id: str, kind: str, components: dict[str, str]) -> None:
        def delete_and_release(tx: TransactionLike) -> None:
            self.store.releaseUniqueKey(tx, kind, components)
            tx.delete(self.store._ref(collection, doc_id))
        self.store.runTransaction(delete_and_release)
    def __call__(self, job: dict[str, Any], _directory: Path) -> dict[str, Any]:
        workspace_id = str(job["ownerWorkspaceId"]); ctx = RuleStoreContext(workspace_id, None, "system"); payload = job.get("payload", {})
        if isinstance(payload, dict) and payload.get("subject"):
            return self._subject(ctx, str(payload["subject"]), str(job["id"]))
        workspace = self.store._ref("workspaces", workspace_id).get().to_dict() or {}
        # Once the primitive has established its durable fence, a retry must
        # resume the sweep even if a racing installation is already active.
        if workspace.get("purgeStartedAt"):
            return self.store.purgeWorkspace(ctx, workspace_id, preserveJobId=str(job["id"]))
        deleted = self.store._server_list("installations", {"ownerWorkspaceId": workspace_id, "status": "deleted"})
        # K14: an active replacement installation cancels every matching uninstall
        # tombstone, but never resurrects an older unrelated soft deletion.
        if self.store._server_list("installations", {"ownerWorkspaceId": workspace_id, "status": "active"}):
            for installation in deleted:
                stamp = installation.get("deletedAt")
                if stamp is None: continue
                # Reinstallation must not resurrect the old GitHub installation,
                # only the workspace and customer content that belonged to it.
                for table in (t for t in GOV_AND_CONTENT if t != "installations"):
                    records = [self.store._ref("workspaces", workspace_id).get().to_dict()] if table == "workspaces" else self.store._server_list(table, {"ownerWorkspaceId": workspace_id, "deletedAt": stamp})
                    for record in [r for r in records if r and r.get("deletedAt") == stamp]:
                        patch = {"deletedAt": None, **({"status": "active"} if table == "workspaces" else {})}
                        self.store.runTransaction(lambda tx, t=table, i=str(record["id"]), p=patch: tx.update(self.store._ref(t, i), p))
            return {"cancelled": True}
        # preserveJobId: this job's own record lives in the analysis_jobs table being
        # swept, under the same ownerWorkspaceId. Excluding it lets run_job's normal
        # completion path record "done" instead of the job disappearing mid-purge.
        return self.store.purgeWorkspace(ctx, workspace_id, preserveJobId=str(job["id"]))
    def _subject(self, ctx: RuleStoreContext, user_id: str, job_id: str) -> dict[str, Any]:
        # The Core schema has no pr_review_comments producer yet.  Keep the
        # deterministic hash scan so adding that producer requires no new flow.
        user = self.store._ref("users", user_id).get().to_dict() or {}; login_hash = sha256HexString(str(user.get("login", "")))
        for comment in self.store._server_list("pr_review_comments", {"ownerWorkspaceId": ctx.workspaceId}):
            if comment.get("authorLoginHash") == login_hash: self.store.runTransaction(lambda tx, i=str(comment["id"]): tx.delete(self.store._ref("pr_review_comments", i)))

        github_user_id = user.get("githubUserId")
        personal_workspace_id = user.get("personalWorkspaceId")
        if github_user_id:
            self.store.runTransaction(lambda tx: self.store.releaseUniqueKey(tx, "github_user", {"githubUserId": str(github_user_id)}))
        self.store.runTransaction(lambda tx: self.store.releaseUniqueKey(tx, "user_preference", {"userId": user_id}))

        # Pending invitations addressed to the deleted account can never be accepted
        # by anyone (the account is gone), so they're deleted outright and their
        # reserved unique key released. A non-pending invitation the deleted user was
        # invited through (accepted/declined) is left in place for the Workspace's
        # history, but the deleted user's identity is anonymized out of it -- same
        # for any invitation they sent or accepted as a different party.
        if github_user_id:
            for invitation in self.store._server_list("workspace_invitations", {"invitedGithubUserId": str(github_user_id)}):
                if invitation.get("status") == "pending":
                    self._delete_and_release("workspace_invitations", str(invitation["id"]), "workspace_invitation_pending", {"workspaceId": str(invitation["workspaceId"]), "invitedGithubUserId": str(github_user_id)})
                else:
                    self.store.runTransaction(lambda tx, i=str(invitation["id"]): tx.update(self.store._ref("workspace_invitations", i), {"invitedGithubUserId": None, "invitedGithubLogin": None}))
        for field in ("invitedByUserId", "acceptedByUserId"):
            for invitation in self.store._server_list("workspace_invitations", {field: user_id}):
                self.store.runTransaction(lambda tx, i=str(invitation["id"]), f=field: tx.update(self.store._ref("workspace_invitations", i), {f: None}))

        # Account deletion is global: drop this user's membership in every Workspace,
        # not just their own personal one. Organization Workspaces and their
        # content are never touched here (only the membership row), so this can't
        # orphan another user's data -- but leaving Organization membership behind
        # for a deleted userId turns into a ghost member (and, if the same GitHub
        # account re-registers later, a new userId that can never rejoin the
        # Organization it used to belong to, since the old membership never frees
        # its workspace_member unique key).
        for member in self.store._server_list("workspace_members", {"userId": user_id}):
            member_workspace_id, member_id = str(member["workspaceId"]), str(member["id"])
            # Same transaction: a crash between "membership deleted" and "unique key
            # released" would otherwise leave the key permanently stranded, since
            # nothing indexes unique_keys by the membership doc that once claimed it.
            self._delete_and_release("workspace_members", member_id, "workspace_member", {"workspaceId": member_workspace_id, "userId": user_id})

        if personal_workspace_id:
            workspace_id = str(personal_workspace_id)
            # Reuse the already-tested UC-06 primitive so every content table the
            # personal Workspace owns (projects, rules, decision_memories, ...) is
            # deleted too, not just workspace_members.  purgeWorkspace deliberately
            # skips the "kind"=="personal" workspaces doc itself, so that final
            # deletion still happens explicitly below.  preserveJobId: when the
            # deletion request targeted this same personal Workspace, this purge
            # job's own analysis_jobs record lives in the sweep purgeWorkspace is
            # about to run -- see purgeWorkspace's docstring for why that matters.
            self.store.purgeWorkspace(RuleStoreContext(workspace_id, None, "system"), workspace_id, preserveJobId=job_id)
            self.store.runTransaction(lambda tx: tx.delete(self.store._ref("workspaces", workspace_id)))

        for table in ("user_preferences", "users"):
            for record in self.store._server_list(table, {"userId" if table == "user_preferences" else "id": user_id}): self.store.runTransaction(lambda tx, t=table, i=str(record["id"]): tx.delete(self.store._ref(t, i)))
        return {"subjectPurged": user_id}
