import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import test from "node:test";
import { AuthService, type GitHubUser } from "../src/shared/auth.ts";
import { GitHubAppAuth, GitHubAppService, GITHUB_APP_EVENTS, GITHUB_APP_PERMISSIONS, type GitHubAppApiClient, type GitHubInstallationPayload, verifyGitHubWebhookSignature } from "../src/shared/github-app.ts";
import { createGitHubAppHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { signSession } from "../src/shared/auth.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const payload = (overrides: Partial<GitHubInstallationPayload> = {}): GitHubInstallationPayload => ({ action: "created", installation: { id: "900", account: { id: "42", login: "acme", type: "Organization" }, repository_selection: "selected", permissions: { contents: "write" } }, sender: { id: "7", login: "installer" }, ...overrides });
class FakeGitHubApp implements GitHubAppApiClient {
  installation = payload(); tokens: string[] = [];
  async getInstallation(_id: string) { return this.installation; }
  async listInstallationRepositories(_id: string) { return [{ id: "1", name: "api", full_name: "acme/api" }]; }
  async createInstallationAccessToken(_id: string, jwt: string) { this.tokens.push(jwt); return { token: "must-never-persist", expires_at: "2026-01-01T00:00:00Z" }; }
}
const signedWebhook = (body: unknown, event = "installation", delivery = "d-1") => { const raw = JSON.stringify(body), secret = "hook-secret"; return new Request("https://app.test/api/github/webhook", { method: "POST", headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` }, body: raw }); };
const docs = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((value) => value.data()!);

test("malformed signature headers are rejected before reading the body, and duplicate delivery changes nothing", async () => {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), service = new GitHubAppService(new FirestoreRuleStore(db), new FakeGitHubApp());
  for (const signature of [null, "sha256=nope", `sha256=${"A".repeat(64)}`, `sha1=${"0".repeat(64)}`, `sha256=${"0".repeat(63)}`, `sha256=${"0".repeat(65)}`]) {
    const headers: Record<string, string> = { "x-github-event": "installation", "x-github-delivery": "bad" };
    if (signature !== null) headers["x-hub-signature-256"] = signature;
    const invalid = new Request("https://app.test", { method: "POST", headers, body: JSON.stringify(payload()) });
    assert.equal((await service.receiveWebhook(invalid, "hook-secret")).status, 401);
    assert.equal(invalid.bodyUsed, false);
  }
  assert.equal(docs(db, "webhook_deliveries").length, 0);
  assert.equal((await service.receiveWebhook(signedWebhook(payload()), "hook-secret")).status, 200); const installations = structuredClone(docs(db, "installations"));
  assert.equal((await service.receiveWebhook(signedWebhook(payload()), "hook-secret")).status, 200); assert.deepEqual(docs(db, "installations"), installations); assert.equal(docs(db, "webhook_deliveries").length, 1);
});

test("webhook payloads are bounded even without Content-Length", async () => {
  const db = new InMemoryFirestore(), service = new GitHubAppService(new FirestoreRuleStore(db), new FakeGitHubApp());
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(17))); controller.close(); } });
  const request = new Request("https://app.test/api/github/webhook", { method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
  const response = await service.receiveWebhook(request, "hook-secret", 16);
  assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: "WEBHOOK_PAYLOAD_TOO_LARGE" }); assert.equal(docs(db, "webhook_deliveries").length, 0);
});

test("organization workspaces are unique, all-repository installs are rejected, and only fixed permissions are stored", async () => {
  const db = new InMemoryFirestore(), service = new GitHubAppService(new FirestoreRuleStore(db), new FakeGitHubApp());
  await service.receiveWebhook(signedWebhook(payload(), "installation", "org-1"), "hook-secret"); await service.receiveWebhook(signedWebhook(payload(), "installation", "org-2"), "hook-secret");
  assert.equal(docs(db, "workspaces").filter((w) => w.kind === "organization").length, 1); assert.deepEqual(docs(db, "installations")[0]!.permissionsGranted, GITHUB_APP_PERMISSIONS); assert.equal("issues" in GITHUB_APP_PERMISSIONS, false); assert.deepEqual(GITHUB_APP_EVENTS, ["installation", "push", "pull_request"]);
  const all = payload(); all.installation = { ...all.installation, id: "all", repository_selection: "all" }; await service.receiveWebhook(signedWebhook(all, "installation", "all-1"), "hook-secret"); assert.equal(docs(db, "installations").some((i) => i.githubInstallationId === "all"), false);
  const api = new FakeGitHubApp(); api.installation = all; const handlers = createGitHubAppHandlers(new GitHubAppService(new FirestoreRuleStore(db), api), "session", "hook-secret"); const user = { id: "no-user" }; const response = await handlers.setup(new Request("https://app.test/setup?installation_id=all&setup_action=install", { headers: { cookie: `rulebranch_session=${signSession({ userId: user.id, issuedAt: Date.now() }, "session")}` } })); assert.equal(response.status, 302); assert.equal(new URL(response.headers.get("location")!).pathname, "/install/error"); assert.equal(new URL(response.headers.get("location")!).searchParams.get("code"), "REPOSITORY_SELECTION_ALL_NOT_ALLOWED");
  const repositories = await handlers.repositories(new Request("https://app.test/api/installations/900/repositories"), "900"); assert.equal(repositories.status, 401);
});

test("setup grants installer owner then admin on reinstallation, and login backfill supplies missed owner", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), api = new FakeGitHubApp(), service = new GitHubAppService(store, api); const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async (): Promise<GitHubUser> => ({ id: "7", login: "installer" }) }, service);
  const installer = await auth.loginGitHubUser({ id: "7", login: "installer" }); await service.receiveWebhook(signedWebhook(payload(), "installation", "setup-1"), "hook-secret");
  const setup = await service.setup(installer.id, "900", "install"); assert.equal(setup.installationId, "900"); assert.ok(setup.workspaceId); let members = docs(db, "workspace_members").filter((m) => m.joinedVia === "installer"); assert.equal(members[0]!.role, "owner");
  const suspended = { ...payload(), action: "suspend" }; await service.receiveWebhook(signedWebhook(suspended, "installation", "suspend-1"), "hook-secret"); assert.equal(docs(db, "installations")[0]!.status, "suspended"); assert.equal(docs(db, "audit_logs").some((entry) => entry.action === "installation.suspend"), true);
  const other = await auth.loginGitHubUser({ id: "8", login: "other" }); api.installation = { ...payload(), sender: { id: "8", login: "other" } };
  await service.receiveWebhook(signedWebhook(api.installation, "installation", "reinstall"), "hook-secret");
  await service.setup(other.id, "900", "install"); members = docs(db, "workspace_members").filter((m) => m.joinedVia === "installer"); assert.equal(members.find((m) => m.userId === other.id)!.role, "admin");
  const db2 = new InMemoryFirestore(), store2 = new FirestoreRuleStore(db2), service2 = new GitHubAppService(store2, api); await service2.receiveWebhook(signedWebhook(payload(), "installation", "backfill"), "hook-secret"); const auth2 = new AuthService(store2, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "7", login: "installer" }) }, service2); await auth2.loginGitHubUser({ id: "7", login: "installer" }); assert.equal(docs(db2, "workspace_members").filter((m) => m.joinedVia === "installer")[0]!.role, "owner");
  const db3 = new InMemoryFirestore(), store3 = new FirestoreRuleStore(db3), service3 = new GitHubAppService(store3, api); const userInstallation = payload(); userInstallation.installation = { ...userInstallation.installation, id: "user-install", account: { id: "7", login: "installer", type: "User" } }; await service3.receiveWebhook(signedWebhook(userInstallation, "installation", "user-install"), "hook-secret"); const auth3 = new AuthService(store3, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "7", login: "installer" }) }, service3); const user3 = await auth3.loginGitHubUser({ id: "7", login: "installer" }); assert.equal(docs(db3, "installations")[0]!.ownerWorkspaceId, user3.personalWorkspaceId);
});

test("setup accepts the direct installation object returned by GitHub's REST API", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  const installation = payload().installation;
  const api: GitHubAppApiClient = {
    async getInstallation() { return installation; },
    async listInstallationRepositories() { return []; },
    async createInstallationAccessToken() { return { token: "unused", expires_at: "never" }; },
  };
  const service = new GitHubAppService(store, api);
  const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async (): Promise<GitHubUser> => ({ id: "7", login: "installer" }) }, service);
  const user = await auth.loginGitHubUser({ id: "7", login: "installer" });
  await service.receiveWebhook(signedWebhook(payload(), "installation", "direct-rest"), "hook-secret");
  const result = await service.setup(user.id, "900", "install");
  assert.equal(result.installationId, "900");
  assert.ok(result.workspaceId);
});

test("setup cannot replace the signed installer or grant another user organization access", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), api = new FakeGitHubApp();
  const directApi = { ...api, getInstallation: async () => payload().installation,
    listInstallationRepositories: async () => [], createInstallationAccessToken: async () => ({ token: "t", expires_at: "never" }) };
  const service = new GitHubAppService(store, directApi);
  const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "7", login: "installer" }) });
  const installer = await auth.loginGitHubUser({ id: "7", login: "installer" });
  const other = await auth.loginGitHubUser({ id: "8", login: "other" });
  await service.receiveWebhook(signedWebhook(payload(), "installation", "verified-installer"), "hook-secret");
  const before = structuredClone(docs(db, "installations"));
  await assert.rejects(service.setup(other.id, "900", "install"), (error: RuleStoreError) => error.code === "INSTALLER_MISMATCH");
  assert.deepEqual(docs(db, "installations"), before);
  assert.equal(docs(db, "workspace_members").some((member) => member.userId === other.id && member.workspaceId === before[0]!.ownerWorkspaceId), false);
  const result = await service.setup(installer.id, "900", "install");
  assert.equal(result.workspaceId, before[0]!.ownerWorkspaceId);
});

test("setup waits for the verified webhook and cannot revive a suspended installation", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  const api = { getInstallation: async () => payload().installation, listInstallationRepositories: async () => [],
    createInstallationAccessToken: async () => ({ token: "t", expires_at: "never" }) };
  const service = new GitHubAppService(store, api);
  const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "7", login: "installer" }) });
  const user = await auth.loginGitHubUser({ id: "7", login: "installer" });
  await assert.rejects(service.setup(user.id, "900", "install"), (error: RuleStoreError) => error.code === "INSTALLATION_NOT_READY");
  assert.equal(docs(db, "installations").length, 0);
  await service.receiveWebhook(signedWebhook(payload(), "installation", "create"), "hook-secret");
  await service.receiveWebhook(signedWebhook({ ...payload(), action: "suspend" }, "installation", "suspend"), "hook-secret");
  await assert.rejects(service.setup(user.id, "900", "install"), (error: RuleStoreError) => error.code === "NOT_FOUND");
  assert.equal(docs(db, "installations")[0]!.status, "suspended");
});

test("RS256 app JWT exchanges a token without storing it and webhook HMAC is constant-format verified", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }), api = new FakeGitHubApp(), auth = new GitHubAppAuth({ appId: "123", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, api); const jwt = auth.createAppJwt(1_000);
  const [header, claims, signature] = jwt.split("."); assert.equal(verifySignature("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url")), true); assert.equal(await auth.installationToken("900"), "must-never-persist"); assert.equal(api.tokens.length, 1); assert.equal(verifyGitHubWebhookSignature("body", "sha256=bad", "secret"), false);
});

test("removed GitHub App installer stays removed across login backfill and verified setup", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), api = new FakeGitHubApp();
  const app = new GitHubAppService(store, api);
  const auth = new AuthService(store, { exchangeCodeForToken: async () => "x", getAuthenticatedUser: async () => ({ id: "7", login: "installer" }) }, app);
  const installer = await auth.loginGitHubUser({ id: "7", login: "installer" });
  await app.receiveWebhook(signedWebhook(payload(), "installation", "installer-revoke"), "hook-secret");
  const installation = docs(db, "installations")[0]!;
  const workspaceId = String(installation.ownerWorkspaceId);
  await app.setup(installer.id, "900", "install");
  const other = await auth.loginGitHubUser({ id: "8", login: "other" });
  const otherMemberId = "co-owner";
  db.put(`workspace_members/${otherMemberId}`, { id: otherMemberId, workspaceId, userId: other.id, role: "owner" });
  db.put(`unique_keys/workspace_member:${workspaceId}:${other.id}`, { id: `workspace_member:${workspaceId}:${other.id}`, ownerWorkspaceId: workspaceId, targetId: otherMemberId });
  const { WorkspaceInvitationsService } = await import("../src/shared/workspace-invitations.ts");
  const members = new WorkspaceInvitationsService(store, { getUserByLogin: async () => null });
  const installerMemberId = String(docs(db, "workspace_members").find((m) => m.workspaceId === workspaceId && m.userId === installer.id)!.id);
  await members.removeMember(workspaceId, other.id, installerMemberId);
  assert.equal(docs(db, "workspace_members").filter((m) => m.workspaceId === workspaceId && m.userId === installer.id).length, 0);
  assert.deepEqual(docs(db, "workspaces").find((w) => w.id === workspaceId)?.revokedInstallerUserIds, [installer.id]);
  await auth.loginGitHubUser({ id: "7", login: "installer" });
  await app.setup(installer.id, "900", "install");
  assert.equal(docs(db, "workspace_members").filter((m) => m.workspaceId === workspaceId && m.userId === installer.id).length, 0);
});

test("reinstall restores only content deleted by the prior uninstall", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), app = new GitHubAppService(store, new FakeGitHubApp());
  await app.receiveWebhook(signedWebhook(payload(), "installation", "install-original"), "hook-secret");
  const workspaceId = String(docs(db, "installations")[0]!.ownerWorkspaceId);
  db.put("projects/demo", {id:"demo",ownerWorkspaceId:workspaceId,deletedAt:null});
  db.put("projects/intentionally-removed", {id:"intentionally-removed",ownerWorkspaceId:workspaceId,deletedAt:"prior"});
  await app.receiveWebhook(signedWebhook({...payload(),action:"deleted"}, "installation", "uninstall"), "hook-secret");
  assert.equal(docs(db, "workspaces").find((w)=>w.id===workspaceId)?.status,"deleted");
  assert.ok(docs(db,"projects").find((p)=>p.id==="demo")?.deletedAt);
  const installAgain = payload();
  installAgain.installation = {...installAgain.installation,id:"901"};
  await app.receiveWebhook(signedWebhook(installAgain, "installation", "reinstall-new-id"), "hook-secret");
  assert.equal(docs(db,"workspaces").find((w)=>w.id===workspaceId)?.status,"active");
  assert.equal(docs(db,"workspaces").find((w)=>w.id===workspaceId)?.deletedAt,null);
  assert.equal(docs(db,"projects").find((p)=>p.id==="demo")?.deletedAt,null);
  assert.equal(docs(db,"projects").find((p)=>p.id==="intentionally-removed")?.deletedAt,"prior");
  assert.equal(docs(db,"installations").find((i)=>i.githubInstallationId==="900")?.status,"deleted");
  assert.equal(docs(db,"installations").find((i)=>i.githubInstallationId==="901")?.status,"active");
});

test("purge marker rejects a new installation before it can restore tombstoned content", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), app = new GitHubAppService(store, new FakeGitHubApp());
  await app.receiveWebhook(signedWebhook(payload(), "installation", "purge-install-original"), "hook-secret");
  const workspaceId = String(docs(db, "installations")[0]!.ownerWorkspaceId);
  db.put("projects/demo", { id: "demo", ownerWorkspaceId: workspaceId, deletedAt: null });
  await app.receiveWebhook(signedWebhook({ ...payload(), action: "deleted" }, "installation", "purge-uninstall"), "hook-secret");
  const workspace = docs(db, "workspaces").find((item) => item.id === workspaceId)!;
  db.put(`workspaces/${workspaceId}`, { ...workspace, purgeStartedAt: new Date().toISOString() });
  const reinstall = payload();
  reinstall.installation = { ...reinstall.installation, id: "purge-reinstall" };
  await assert.rejects(
    app.receiveWebhook(signedWebhook(reinstall, "installation", "purge-reinstall-delivery"), "hook-secret"),
    (error: unknown) => error instanceof RuleStoreError && error.code === "WORKSPACE_PURGING" && error.status === 409,
  );
  assert.equal(docs(db, "installations").some((item) => item.githubInstallationId === "purge-reinstall"), false);
  assert.notEqual(docs(db, "projects").find((item) => item.id === "demo")?.deletedAt, null);

  const original = docs(db, "installations").find((item) => item.githubInstallationId === "900")!;
  db.put(`installations/${original.id}`, { ...original, status: "suspended" });
  await assert.rejects(
    app.receiveWebhook(signedWebhook({ ...payload(), action: "unsuspend" }, "installation", "purge-unsuspend"), "hook-secret"),
    (error: unknown) => error instanceof RuleStoreError && error.code === "WORKSPACE_PURGING" && error.status === 409,
  );
  assert.equal(docs(db, "installations").find((item) => item.id === original.id)?.status, "suspended");
});
