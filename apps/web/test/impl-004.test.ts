import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuthService, SESSION_MAX_AGE_MS, TRANSFER_POLICY_PROHIBITED, signSession, verifySession } from "../src/shared/auth.ts";
import { requireRole } from "../src/shared/authz.ts";
import { createAuthHandlers, createUserPreferencesHandlers } from "../src/shared/http-api.ts";
import { canApproveRuleVersion, canChangeMemberRole, canInvite, canRecompile, canRestoreArchivedRule, canTriage, canTransferProject, canTransferWorkspace, canUninstall, canWrite, hasRole, type WorkspaceRole } from "../src/shared/permissions.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { UserPreferencesService } from "../src/shared/user-preferences.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const github = { async exchangeCodeForToken(code: string) { assert.equal(code, "code"); return "token"; }, async getAuthenticatedUser(token: string) { assert.equal(token, "token"); return { id: 42, login: "octo", name: "Octo Cat", email: "octo@example.test" }; } };
async function fixture() { const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db); const auth = new AuthService(store, github); const user = await auth.loginWithCode("code", "login-1"); return { db, store, auth, user, preferences: new UserPreferencesService(store) }; }
test("OAuth callback creates one account graph and repeat/concurrent logins do not duplicate it", async () => {
  const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db); const auth = new AuthService(store, github);
  const [first, second] = await Promise.all([auth.loginWithCode("code", "r1"), auth.loginWithCode("code", "r2")]);
  assert.equal(first.id, second.id); const ctx = { workspaceId: first.personalWorkspaceId, actorUserId: first.id };
  assert.deepEqual(["users", "workspaces", "workspace_members", "user_preferences"].map((collection) => db.query(collection, []).length), [1, 1, 1, 1]);
  // The global reservations are the canonical one-to-one account indexes.
  assert.ok((await store.documentRef("unique_keys", "github_user:42").get()).exists); assert.ok((await store.documentRef("unique_keys", `user_preference:${first.id}`).get()).exists); assert.ok((await store.documentRef("workspaces", first.personalWorkspaceId).get()).exists);
  const user = await store.documentRef("users", first.id).get(); assert.equal(user.data()!.locale, "ja"); assert.ok(user.data()!.lastLoginAt);
  const memberKey = await store.documentRef("unique_keys", `workspace_member:${first.personalWorkspaceId}:${first.id}`).get(); const member = (await store.documentRef("workspace_members", memberKey.data()!.targetId as string).get()).data()!; assert.deepEqual({ role: member.role, joinedVia: member.joinedVia }, { role: "owner", joinedVia: "personal_owner" });
  const preferenceKey = await store.documentRef("unique_keys", `user_preference:${first.id}`).get(); const preference = (await store.documentRef("user_preferences", preferenceKey.data()!.targetId as string).get()).data()!; assert.equal(preference.transferPolicy, TRANSFER_POLICY_PROHIBITED); assert.deepEqual(preference.notifications, {});
  assert.equal((await store.list(ctx, "audit_logs")).filter((item) => item.action === "user.login").length, 1);
});
test("initial OAuth login keeps all Firestore transaction reads ahead of writes", async () => {
  const store = new FirestoreRuleStore(new InMemoryFirestore({ enforceReadBeforeWrite: true }));
  const user = await new AuthService(store, github).loginGitHubUser({ id: 43, login: "read-before-write" });
  assert.equal(user.githubUserId, "43");
});
test("subsequent login changes only users.lastLoginAt", async () => {
  const { auth, store, user } = await fixture(); const before = (await store.documentRef("users", user.id).get()).data()!; const result = await auth.loginWithCode("code", "login-again"); const after = (await store.documentRef("users", user.id).get()).data()!;
  assert.equal(result.id, user.id); for (const key of Object.keys(before)) if (key !== "lastLoginAt") assert.deepEqual(after[key], before[key]);
});
test("OAuth callback uses injected GitHub API and creates a signed session", async () => {
  const { auth } = await fixture(); const response = await createAuthHandlers(auth, "secret").callback(new Request("https://app.test/api/auth/github/callback?code=code&state=state", { headers: { cookie: "rulebranch_oauth_state=state" } }));
  assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "https://app.test/");
  const setCookies = response.headers.getSetCookie(); assert.equal(setCookies.length, 3);
  assert.ok(setCookies.some((value) => new RegExp(`^rulebranch_session=.*Max-Age=${SESSION_MAX_AGE_MS / 1000}`).test(value))); assert.ok(setCookies.some((value) => /^rulebranch_oauth_state=;.*Max-Age=0/.test(value))); assert.ok(setCookies.some((value) => /^rulebranch_oauth_next=;.*Max-Age=0/.test(value)));
});
test("expired sessions are rejected", () => {
  assert.equal(verifySession(signSession({ userId: "user", issuedAt: Date.now() - SESSION_MAX_AGE_MS - 1 }, "secret"), "secret"), null);
});
test("malformed and non-current sessions are rejected without throwing", () => {
  const secret = "secret", now = Date.now();
  assert.equal(verifySession(signSession({ userId: "user", issuedAt: now + 60_000 }, secret), secret), null);
  assert.equal(verifySession(signSession({ userId: "", issuedAt: now }, secret), secret), null);
  assert.equal(verifySession(`${signSession({ userId: "user", issuedAt: now }, secret)}.ignored`, secret), null);
  assert.equal(verifySession(`body.${"あ".repeat(43)}`, secret), null);
});
test("there is no email/password authentication route or implementation", () => {
  const routes = resolve(import.meta.dirname, "../src/app/api"); const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
  const source = walk(routes).map((file) => `${file}\n${readFileSync(file, "utf8")}`).join("\n"); assert.doesNotMatch(source, /(?:password|credentials)(?:\/|["'])|email[-_/]?(?:login|auth)/i);
});
test("permissions cover every requirements 4.2 matrix row", () => {
  assert.ok(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "locked", scopeType: "project" }, "admin")); assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "locked", scopeType: "project" }, "maintainer"), false);
  assert.ok(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "default", scopeType: "project" }, "maintainer")); assert.ok(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "advisory", scopeType: "project" }, "owner"));
  for (const operation of [canRestoreArchivedRule, canUninstall, canTransferWorkspace, canTransferProject, canTriage, canRecompile, canWrite]) assert.ok(operation("personal", "owner"));
  assert.ok(canRestoreArchivedRule("organization", "admin")); assert.equal(canRestoreArchivedRule("organization", "maintainer"), false);
  assert.ok(canUninstall("organization", "admin")); assert.equal(canUninstall("organization", "maintainer"), false);
  assert.ok(canTransferWorkspace("organization", "owner")); assert.equal(canTransferWorkspace("organization", "admin"), false);
  assert.ok(canTransferProject("organization", "admin")); assert.equal(canTransferProject("organization", "maintainer"), false);
  assert.ok(canInvite("admin", "maintainer")); assert.equal(canInvite("admin", "admin"), false); assert.ok(canInvite("owner", "admin"));
  assert.ok(canChangeMemberRole("organization", "owner", "owner")); assert.equal(canChangeMemberRole("organization", "admin", "admin"), false); assert.ok(canTriage("organization", "maintainer")); assert.equal(canTriage("organization", "member"), false);
  for (const role of ["viewer"] as WorkspaceRole[]) { assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "locked", scopeType: "project" }, role), false); assert.equal(canRestoreArchivedRule("organization", role), false); assert.equal(canUninstall("organization", role), false); assert.equal(canTransferWorkspace("organization", role), false); assert.equal(canTransferProject("organization", role), false); assert.equal(canInvite(role, "viewer"), false); assert.equal(canTriage("organization", role), false); assert.equal(canRecompile("organization", role), false); assert.equal(canWrite("organization", role), false); }
});
test("requireRole uses workspace membership and viewers receive 403 on writes", async () => {
  const { store, user } = await fixture(); const ws = user.personalWorkspaceId; const viewerId = "viewer";
  await store.runTransaction(async (tx) => { await store.reserveUniqueKey(tx, "workspace_member", { workspaceId: ws, userId: viewerId }, { targetTable: "workspace_members", targetId: "viewer-member" }); tx.create(store.documentRef("workspace_members", "viewer-member"), { id: "viewer-member", workspaceId: ws, userId: viewerId, role: "viewer" }); });
  await assert.rejects(requireRole(store, ws, viewerId, "member"), (error: RuleStoreError) => error.status === 403); assert.equal(await requireRole(store, ws, user.id, "owner"), "owner"); assert.equal(hasRole("owner", "admin"), true);
});
test("GET/PATCH user-preferences permits only mutable fields, audits update, and rejects notifications", async () => {
  const { store, user, preferences } = await fixture(); const handlers = createUserPreferencesHandlers(preferences, "secret"); const cookie = `rulebranch_session=${signSession({ userId: user.id, issuedAt: Date.now() }, "secret")}`;
  const get = await handlers.get(new Request("https://app.test/user-preferences", { headers: { cookie } })); assert.equal(get.status, 200); assert.deepEqual((await get.json()).notifications, {});
  const patch = await handlers.patch(new Request("https://app.test/user-preferences", { method: "PATCH", headers: { cookie, "content-type": "application/json", "x-requested-with":"RuleBranch" }, body: JSON.stringify({ locale: "en", explanationLevel: "detailed", reviewDisplay: { compact: true } }) })); assert.equal(patch.status, 200); assert.equal((await patch.json()).locale, "en");
  const blocked = await handlers.patch(new Request("https://app.test/user-preferences", { method: "PATCH", headers: { cookie, "content-type": "application/json", "x-requested-with":"RuleBranch" }, body: JSON.stringify({ notifications: { email: true } }) })); assert.equal(blocked.status, 422);
  const audits = await store.list({ workspaceId: user.personalWorkspaceId, actorUserId: user.id }, "audit_logs"); assert.equal(audits.filter((item) => item.action === "user_preferences.update").length, 1);
});
