import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, signSession } from "../src/shared/auth.ts";
import { createWorkspaceInvitationHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { WorkspaceInvitationsService, type GitHubUserLookupClient } from "../src/shared/workspace-invitations.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

class FakeGitHubUsers implements GitHubUserLookupClient {
  readonly users = new Map<string, { id: string; login: string }>();
  async getUserByLogin(login: string) { return this.users.get(login.toLowerCase()) ?? null; }
}
const docs = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((item) => item.data()!);
async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), github = new FakeGitHubUsers(); let now = new Date("2026-09-06T00:00:00.000Z");
  const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "0", login: "unused" }) });
  const owner = await auth.loginGitHubUser({ id: "1", login: "owner" }), admin = await auth.loginGitHubUser({ id: "2", login: "admin" }), invitee = await auth.loginGitHubUser({ id: "3", login: "invitee" });
  github.users.set("invitee", { id: "3", login: "Invitee" });
  const workspaceId = "organization-workspace";
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspaces", workspaceId), { id: workspaceId, kind: "organization", status: "active" });
    for (const [id, userId, role] of [["owner-member", owner.id, "owner"], ["admin-member", admin.id, "admin"]] as const) { await store.reserveUniqueKey(tx, "workspace_member", { workspaceId, userId }, { targetTable: "workspace_members", targetId: id }); tx.create(store.documentRef("workspace_members", id), { id, workspaceId, userId, role, joinedVia: "installer", invitationId: null }); }
  });
  return { db, store, github, service: new WorkspaceInvitationsService(store, github, () => now), owner, admin, invitee, workspaceId, setNow: (value: Date) => { now = value; } };
}

test("invite by GitHub login and accept creates the invitation membership and frees the pending key", async () => {
  const f = await fixture(); const invitation = await f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "invitee", role: "maintainer" });
  assert.equal(invitation.invitedGithubUserId, "3"); assert.equal((await f.service.listMyInvitations(f.invitee.id)).length, 1);
  const member = await f.service.acceptInvitation(f.invitee.id, invitation.id as string); assert.deepEqual({ role: member.role, joinedVia: member.joinedVia, invitationId: member.invitationId }, { role: "maintainer", joinedVia: "invitation", invitationId: invitation.id });
  assert.equal(docs(f.db, "unique_keys").some((key) => key.kind === "workspace_invitation_pending"), false); assert.equal(docs(f.db, "audit_logs").some((entry) => entry.action === "workspace.invite_accept"), true);
});

test("personal, unknown users, owner role, and admin-to-admin invitations are rejected", async () => {
  const f = await fixture();
  await assert.rejects(f.service.createInvitation(f.owner.personalWorkspaceId, f.owner.id, { githubLogin: "invitee", role: "member" }), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "missing", role: "member" }), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "invitee", role: "owner" as never }), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(f.service.createInvitation(f.workspaceId, f.admin.id, { githubLogin: "invitee", role: "admin" }), (e: RuleStoreError) => e.status === 403);
});

test("expired pending invitation is replaced atomically, while live pending invitation conflicts and GET expires it", async () => {
  const f = await fixture(); const first = await f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "invitee", role: "member" });
  await assert.rejects(f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "invitee", role: "member" }), (e: RuleStoreError) => e.code === "INVITATION_ALREADY_PENDING");
  f.setNow(new Date("2026-09-21T00:00:00.000Z")); const second = await f.service.createInvitation(f.workspaceId, f.owner.id, { githubLogin: "invitee", role: "viewer" });
  assert.notEqual(first.id, second.id); assert.equal(docs(f.db, "workspace_invitations").find((item) => item.id === first.id)!.status, "expired"); assert.equal(docs(f.db, "audit_logs").some((entry) => entry.action === "workspace.invite_expire"), true);
  f.setNow(new Date("2026-10-10T00:00:00.000Z")); assert.deepEqual(await f.service.listMyInvitations(f.invitee.id), []); assert.equal(docs(f.db, "workspace_invitations").find((item) => item.id === second.id)!.status, "expired"); assert.equal(docs(f.db, "unique_keys").some((key) => key.kind === "workspace_invitation_pending"), false);
});

test("last owner is protected and invitation/member operations reject AI contexts", async () => {
  const f = await fixture();
  await assert.rejects(f.service.updateMemberRole(f.workspaceId, f.owner.id, "owner-member", "admin"), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(f.service.removeMember(f.workspaceId, f.owner.id, "owner-member"), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(f.service.createInvitation(f.workspaceId, null, { githubLogin: "invitee", role: "member" }), (e: RuleStoreError) => e.status === 403);
  await assert.rejects(f.service.listMembers(f.workspaceId, null), (e: RuleStoreError) => e.status === 403);
  await assert.rejects(f.service.acceptInvitation(null, "nope"), (e: RuleStoreError) => e.status === 403);
});

test("concurrent owner demotions leave one owner because membership changes serialize", async () => {
  const f = await fixture();
  const secondOwner = { id: "second-owner" };
  await f.store.runTransaction(async (tx) => {
    await f.store.reserveUniqueKey(tx, "workspace_member", { workspaceId: f.workspaceId, userId: secondOwner.id }, { targetTable: "workspace_members", targetId: "second-owner-member" });
    tx.create(f.store.documentRef("workspace_members", "second-owner-member"), { id: "second-owner-member", workspaceId: f.workspaceId, userId: secondOwner.id, role: "owner" });
  });
  const results = await Promise.allSettled([
    f.service.updateMemberRole(f.workspaceId, f.owner.id, "second-owner-member", "admin"),
    f.service.updateMemberRole(f.workspaceId, secondOwner.id, "owner-member", "admin"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && ["FORBIDDEN", "LAST_OWNER_REQUIRED"].includes((result.reason as RuleStoreError).code)).length, 1);
  assert.equal((await f.service.listMembers(f.workspaceId, f.owner.id)).filter((member) => member.role === "owner").length, 1);
});

test("admin cannot demote an owner or another admin even when multiple owners exist", async () => {
  const f = await fixture();
  f.db.put("workspace_members/other-owner", { id: "other-owner", workspaceId: f.workspaceId, userId: f.invitee.id, role: "owner" });
  f.db.put(`unique_keys/workspace_member:${f.workspaceId}:${f.invitee.id}`, { id: `workspace_member:${f.workspaceId}:${f.invitee.id}`, ownerWorkspaceId: f.workspaceId, targetId: "other-owner" });
  for (const memberId of ["owner-member", "other-owner", "admin-member"]) {
    await assert.rejects(f.service.updateMemberRole(f.workspaceId, f.admin.id, memberId, "viewer"),
      (error: RuleStoreError) => error.code === "FORBIDDEN" && error.status === 403);
  }
  assert.equal(docs(f.db, "workspace_members").find((m) => m.id === "other-owner")?.role, "owner");
  assert.equal(docs(f.db, "workspace_members").find((m) => m.id === "admin-member")?.role, "admin");
});

test("role update rejects missing and falsy roles without deleting members or changing revocations", async () => {
  const f = await fixture();
  const originalMembers = docs(f.db, "workspace_members");
  const originalKeys = docs(f.db, "unique_keys");
  const originalAudits = docs(f.db, "audit_logs");
  for (const role of [undefined, null, "", false, 0, [], {}]) {
    await assert.rejects(
      f.service.updateMemberRole(f.workspaceId, f.owner.id, "admin-member", role as never),
      (error: RuleStoreError) => error.code === "INVALID_WORKSPACE_ROLE" && error.status === 422,
    );
  }
  const handlers = createWorkspaceInvitationHandlers(f.service, "member-role-secret");
  const session = signSession({ userId: f.owner.id, issuedAt: Date.now() }, "member-role-secret");
  for (const body of [{}, { role: null }, { role: false }, null]) {
    const request = new Request("https://example.test/member", {
      method: "PATCH",
      headers: { cookie: `rulebranch_session=${session}`, "content-type": "application/json", "x-requested-with": "RuleBranch" },
      body: JSON.stringify(body),
    });
    const response = await handlers.updateMember(request, f.workspaceId, "admin-member");
    assert.equal(response.status, 422);
  }
  assert.deepEqual(docs(f.db, "workspace_members"), originalMembers);
  assert.deepEqual(docs(f.db, "unique_keys"), originalKeys);
  assert.deepEqual(docs(f.db, "audit_logs"), originalAudits);
  assert.equal((await f.store.documentRef("workspaces", f.workspaceId).get()).data()?.revokedInstallerUserIds, undefined);
  // Removal remains available only through the explicitly named removal operation.
  await f.service.removeMember(f.workspaceId, f.owner.id, "admin-member");
  assert.equal(docs(f.db, "workspace_members").some((member) => member.id === "admin-member"), false);
});
