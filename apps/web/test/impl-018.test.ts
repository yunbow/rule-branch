import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import test from "node:test";
import { GitHubAppService, type GitHubAppApiClient } from "../src/shared/github-app.ts";
import { createPurgeHandlers, GoogleOidcVerifier } from "../src/shared/purge-api.ts";
import { FirestoreRuleStore, type DocumentData } from "../src/shared/rulestore.ts";
import { signSession } from "../src/shared/auth.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

function makeGoogleIdToken(claims: Record<string, unknown>): { token: string; jwk: Record<string, string> } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const encodedHeader = b64url({ alg: "RS256", kid: "test-kid" }), encodedPayload = b64url(claims);
  const signature = cryptoSign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), privateKey).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { token: `${encodedHeader}.${encodedPayload}.${signature}`, jwk: { ...jwk, kid: "test-kid", alg: "RS256" } };
}

const api: GitHubAppApiClient = { getInstallation: async () => { throw new Error("unused"); }, listInstallationRepositories: async () => [], createInstallationAccessToken: async () => ({ token: "x", expires_at: "" }) };
const all = (db: InMemoryFirestore, table: string) => db.query(table, []).map((item) => item.data()!);
test("IMPL-018 installation.deleted soft-deletes content and scheduler endpoint is OIDC-only", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api), created = { action: "created", installation: { id: "i", account: { id: "org", login: "o", type: "Organization" as const }, repository_selection: "selected" as const }, sender: { id: "u", login: "u" } };
  const send = async (body: unknown, delivery: string) => { const raw = JSON.stringify(body); return service.receiveWebhook(new Request("https://x", { method: "POST", headers: { "x-github-event": "installation", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", "s").update(raw).digest("hex")}` }, body: raw }), "s"); };
  await send(created, "c"); const workspaceId = String(all(db, "installations")[0]!.ownerWorkspaceId);
  await store.runTransaction(async tx => { tx.create(store.documentRef("projects", "p"), { id: "p", ownerWorkspaceId: workspaceId, deletedAt: null }); tx.create(store.documentRef("rules", "r"), { id: "r", ownerWorkspaceId: workspaceId, deletedAt: null }); });
  await send({ ...created, action: "deleted" }, "d"); const installation = all(db, "installations")[0]!;
  assert.equal(installation.status, "deleted"); assert.equal(Date.parse(String(installation.purgeScheduledAt)) - Date.parse(String(installation.deletedAt)), 30 * 86400000); assert.equal(all(db, "projects")[0]!.deletedAt, installation.deletedAt); assert.equal(all(db, "rules")[0]!.deletedAt, installation.deletedAt);
  const handlers = createPurgeHandlers(store, { verify: token => token === "good" }, "scheduler", "secret"); assert.equal((await handlers.scan(new Request("https://x", { method: "POST" }))).status, 401); assert.equal((await handlers.scan(new Request("https://x", { method: "POST", headers: { authorization: "Bearer bad" } }))).status, 403);
});
test("IMPL-018 redaction preserves audit metadata", async () => { const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: null, actorKind: "system" as const }; await store.appendAuditLog(ctx, { actor: { kind: "system", id: "x" }, action: "data.purge", targetType: "workspaces", targetId: "w", requestId: "r", before: { secret: 1 }, after: { count: 2 } }); const before = all(db, "audit_logs")[0]!; assert.equal((await store.redactAuditLogPayloads(ctx, { workspaceId: "w" })).count, 1); const after = all(db, "audit_logs")[0]!; assert.equal(after.before, null); assert.equal(after.after, null); for (const key of ["payloadHash", "actor", "action", "targetType", "targetId", "occurredAt", "ownerWorkspaceId"]) assert.deepEqual(after[key], before[key]); });
test("IMPL-018 subject request is CSRF-protected, audited, and enqueued idempotently", async () => { const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db); await store.runTransaction(async tx => tx.create(store.documentRef("workspace_members", "m"), { id: "m", workspaceId: "w", userId: "u", role: "admin" })); const handler = createPurgeHandlers(store, { verify: () => true }, "a", "secret"), session = signSession({ userId: "u", issuedAt: Date.now() }, "secret"); const request = (csrf = true) => new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${session}`, "content-type": "application/json", ...(csrf ? { "x-requested-with": "RuleBranch" } : {}) }, body: JSON.stringify({ ownerWorkspaceId: "w", userId: "u", requestId: "request" }) }); assert.equal((await handler.subjectRequest(request(false))).status, 403); assert.equal(all(db, "analysis_jobs").length, 0); assert.equal((await handler.subjectRequest(request())).status, 202); assert.equal((await handler.subjectRequest(request())).status, 202); assert.equal(all(db, "analysis_jobs").length, 1); assert.equal(all(db, "audit_logs").some(log => log.action === "data.subject_request"), true); });
test("IMPL-018 P0 fix: an admin cannot request deletion of another workspace's user account", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  await store.runTransaction(async (tx) => { tx.create(store.documentRef("workspace_members", "admin-a"), { id: "admin-a", workspaceId: "workspace-a", userId: "attacker", role: "admin" }); tx.create(store.documentRef("workspace_members", "member-b"), { id: "member-b", workspaceId: "workspace-b", userId: "victim", role: "member" }); });
  const handler = createPurgeHandlers(store, { verify: () => true }, "a", "secret");
  const cookie = signSession({ userId: "attacker", issuedAt: Date.now() }, "secret");
  // Even naming a target userId that belongs to a workspace the attacker administers is
  // rejected: account deletion is self-service only regardless of membership/role.
  const crossWorkspace = new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${cookie}`, "content-type": "application/json", "x-requested-with": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId: "workspace-a", userId: "victim", requestId: "r1" }) });
  assert.equal((await handler.subjectRequest(crossWorkspace)).status, 403);
  assert.equal(all(db, "analysis_jobs").length, 0);
  const sameWorkspaceOtherUser = new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${cookie}`, "content-type": "application/json", "x-requested-with": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId: "workspace-a", userId: "someone-else", requestId: "r2" }) });
  assert.equal((await handler.subjectRequest(sameWorkspaceOtherUser)).status, 403);
  assert.equal(all(db, "analysis_jobs").length, 0);
  const selfRequest = new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${cookie}`, "content-type": "application/json", "x-requested-with": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId: "workspace-a", requestId: "r3" }) });
  assert.equal((await handler.subjectRequest(selfRequest)).status, 202);
  assert.equal(all(db, "analysis_jobs").length, 1);
});
test("account deletion is rejected when the user is the sole owner of any Organization, regardless of which Workspace is selected", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspaces", "personal"), { id: "personal", kind: "personal" });
    tx.create(store.documentRef("workspaces", "org-solo"), { id: "org-solo", kind: "organization" });
    tx.create(store.documentRef("workspace_members", "m1"), { id: "m1", workspaceId: "personal", userId: "u", role: "owner" });
    tx.create(store.documentRef("workspace_members", "m2"), { id: "m2", workspaceId: "org-solo", userId: "u", role: "owner" });
  });
  const handler = createPurgeHandlers(store, { verify: () => true }, "a", "secret");
  const cookie = signSession({ userId: "u", issuedAt: Date.now() }, "secret");
  const request = (ownerWorkspaceId: string, requestId: string) => new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${cookie}`, "content-type": "application/json", "x-requested-with": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId, requestId }) });
  // Account deletion removes membership everywhere (Worker's _subject is global), so
  // even selecting the *personal* Workspace must be blocked while "u" is still the
  // sole owner of org-solo elsewhere -- deletion would silently leave it ownerless.
  const soleOwnerResponse = await handler.subjectRequest(request("org-solo", "r1"));
  assert.equal(soleOwnerResponse.status, 422); assert.deepEqual(await soleOwnerResponse.json(), { error: "LAST_OWNER_REQUIRED" });
  assert.equal((await handler.subjectRequest(request("personal", "r2"))).status, 422);
  assert.equal(all(db, "analysis_jobs").length, 0);
});
test("account deletion proceeds when the user co-owns every Organization or owns none", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspaces", "personal"), { id: "personal", kind: "personal" });
    tx.create(store.documentRef("workspaces", "org-shared"), { id: "org-shared", kind: "organization" });
    tx.create(store.documentRef("workspace_members", "m1"), { id: "m1", workspaceId: "personal", userId: "u", role: "owner" });
    tx.create(store.documentRef("workspace_members", "m2"), { id: "m2", workspaceId: "org-shared", userId: "u", role: "owner" });
    tx.create(store.documentRef("workspace_members", "m3"), { id: "m3", workspaceId: "org-shared", userId: "other", role: "owner" });
  });
  const handler = createPurgeHandlers(store, { verify: () => true }, "a", "secret");
  const cookie = signSession({ userId: "u", issuedAt: Date.now() }, "secret");
  const request = (ownerWorkspaceId: string, requestId: string) => new Request("https://x", { method: "POST", headers: { cookie: `rulebranch_session=${cookie}`, "content-type": "application/json", "x-requested-with": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId, requestId }) });
  assert.equal((await handler.subjectRequest(request("personal", "r1"))).status, 202);
});
test("GoogleOidcVerifier requires the configured scheduler service account, not just any valid Google-signed token", async () => {
  const goodClaims = { aud: "https://web.example", iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 60, email: "rulebranch-scheduler@p.iam.gserviceaccount.com", email_verified: true };
  const { token: goodToken, jwk } = makeGoogleIdToken(goodClaims);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch;
  try {
    const verifier = new GoogleOidcVerifier("rulebranch-scheduler@p.iam.gserviceaccount.com");
    assert.equal(await verifier.verify(goodToken, "https://web.example"), true);
    // Same signature/audience/issuer, but minted for a different identity: any GCP
    // principal can choose an arbitrary audience when requesting its own ID token, so
    // aud+signature alone do not prove this request came from our scheduler SA.
    const { token: wrongEmailToken } = makeGoogleIdToken({ ...goodClaims, email: "someone-else@other-project.iam.gserviceaccount.com" });
    assert.equal(await verifier.verify(wrongEmailToken, "https://web.example"), false);
    const { token: unverifiedEmailToken } = makeGoogleIdToken({ ...goodClaims, email_verified: false });
    assert.equal(await verifier.verify(unverifiedEmailToken, "https://web.example"), false);
  } finally { globalThis.fetch = originalFetch; }
});
test("jobs-reconcile is OIDC-only and only redispatches stale queued jobs", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  for (const id of ["p1", "p2"]) db.put(`projects/${id}`, { id, ownerWorkspaceId: "w", status: "active", deletedAt: null });
  const ctx = { workspaceId: "w", actorUserId: "u" };
  const fresh = (await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: "p1", payload: {}, idempotencyKey: "bootstrap:p1", requestId: "r1" })).job;
  const stale = (await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: "p2", payload: {}, idempotencyKey: "bootstrap:p2", requestId: "r2" })).job;
  await store.runTransaction(async (tx) => tx.update(store.documentRef("analysis_jobs", stale.id), { createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
  const handler = createPurgeHandlers(store, { verify: (token) => token === "good" }, "scheduler", "secret");
  const redispatched: string[] = []; const redispatch = async (job: DocumentData) => { redispatched.push(String(job.id)); };
  assert.equal((await handler.reconcileJobs(new Request("https://x", { method: "POST" }), redispatch)).status, 401);
  assert.equal((await handler.reconcileJobs(new Request("https://x", { method: "POST", headers: { authorization: "Bearer bad" } }), redispatch)).status, 403);
  const response = await handler.reconcileJobs(new Request("https://x", { method: "POST", headers: { authorization: "Bearer good" } }), redispatch);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { redispatched: 1, failed: 0 });
  assert.deepEqual(redispatched, [stale.id]); assert.equal(redispatched.includes(fresh.id), false);
});
test("jobs-reconcile isolates a per-job redispatch failure so the rest of the batch still runs", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  for (const id of ["a", "b", "c"]) db.put(`projects/${id}`, { id, ownerWorkspaceId: "w", status: "active", deletedAt: null });
  const ctx = { workspaceId: "w", actorUserId: "u" };
  const stale = (id: string) => store.runTransaction(async (tx) => tx.update(store.documentRef("analysis_jobs", id), { createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
  const a = (await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: "a", payload: {}, idempotencyKey: "bootstrap:a", requestId: "ra" })).job; await stale(a.id);
  const b = (await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: "b", payload: {}, idempotencyKey: "bootstrap:b", requestId: "rb" })).job; await stale(b.id);
  const c = (await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: "c", payload: {}, idempotencyKey: "bootstrap:c", requestId: "rc" })).job; await stale(c.id);
  const handler = createPurgeHandlers(store, { verify: () => true }, "scheduler", "secret");
  const succeeded: string[] = []; const redispatch = async (job: DocumentData) => { if (job.id === a.id) throw new Error("temporary"); succeeded.push(String(job.id)); };
  const response = await handler.reconcileJobs(new Request("https://x", { method: "POST", headers: { authorization: "Bearer good" } }), redispatch);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { redispatched: 2, failed: 1 });
  assert.deepEqual(succeeded.sort(), [b.id, c.id].sort());
});
