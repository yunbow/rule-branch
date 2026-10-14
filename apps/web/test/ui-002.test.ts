import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../src/shared/auth.ts";
import { signSession } from "../src/shared/auth.ts";
import { createWorkspaceInvitationHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { WorkspaceInvitationsService, type GitHubUserLookupClient } from "../src/shared/workspace-invitations.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

class GitHubUsers implements GitHubUserLookupClient { async getUserByLogin(login: string) { return login === "invitee" ? { id: "3", login } : null; } }
async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "0", login: "unused" }) });
  const owner = await auth.loginGitHubUser({ id: "1", login: "owner", name: "Owner" }), admin = await auth.loginGitHubUser({ id: "2", login: "admin", name: "Admin" }), invitee = await auth.loginGitHubUser({ id: "3", login: "invitee", name: "Invitee" }); const workspaceId = "organization";
  await store.runTransaction(async (tx) => { tx.create(store.documentRef("workspaces", workspaceId), { id: workspaceId, kind: "organization", name: "Organization" }); for (const [id, userId, role] of [["owner-member", owner.id, "owner"], ["admin-member", admin.id, "admin"]] as const) { await store.reserveUniqueKey(tx, "workspace_member", { workspaceId, userId }, { targetTable: "workspace_members", targetId: id }); tx.create(store.documentRef("workspace_members", id), { id, workspaceId, userId, role, createdAt: "2026-09-01T00:00:00.000Z" }); } });
  const service = new WorkspaceInvitationsService(store, new GitHubUsers()); const invitation = await service.createInvitation(workspaceId, owner.id, { githubLogin: "invitee", role: "member" }); return { db, store, service, owner, admin, invitee, workspaceId, invitation };
}
const request = (userId: string, secret: string) => new Request("https://rulebranch.test/api/workspaces/organization/invitations?status=pending", { headers: { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}` } });

test("UI-002 pending invitations endpoint requires admin and preserves invitation flow", async () => { const f = await fixture(), secret = "secret", handlers = createWorkspaceInvitationHandlers(f.service, secret); assert.equal((await handlers.pending(new Request("https://rulebranch.test/api/workspaces/organization/invitations?status=pending"), f.workspaceId)).status, 401); assert.equal((await handlers.pending(request(f.invitee.id, secret), f.workspaceId)).status, 403); const response = await handlers.pending(request(f.admin.id, secret), f.workspaceId); assert.equal(response.status, 200); assert.equal((await response.json()).invitations[0].id, f.invitation.id); const member = await f.service.acceptInvitation(f.invitee.id, String(f.invitation.id)); assert.equal(member.joinedVia, "invitation"); assert.equal((await f.service.listMyInvitations(f.invitee.id)).length, 0); });

test("UI-002 members batch user joins and include login and displayName", async () => { const f = await fixture(); const before = f.db.getAllCalls, members = await f.service.listMembers(f.workspaceId, f.owner.id); const owner = members.find((member) => member.id === "owner-member"); assert.deepEqual(owner?.user, { login: "owner", displayName: "Owner" }); assert.equal(f.db.getAllCalls - before, 1); });


test("UI-002 personal invitations include workspace and inviter identity", async () => { const f = await fixture(); const invitations = await f.service.listMyInvitations(f.invitee.id); assert.equal(invitations.length, 1); assert.deepEqual(invitations[0].workspace, { name: "Organization" }); assert.deepEqual(invitations[0].invitedBy, { login: "owner", displayName: "Owner" }); });
