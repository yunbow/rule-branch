import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ENUMS, LIMITS } from "../src/shared/contracts.ts";
import { GitHubAppService, type GitHubAppApiClient } from "../src/shared/github-app.ts";
import {
  ANALYSIS_JOB_TYPES, FirestoreRuleStore, RuleStoreError, UNIQUE_KEY_KINDS, canonicalJson, validateAnalysisJobInput, validateRuleVersionInput,
  type AnalysisJobStatus, type AnalysisJobType,
} from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const ctx = { workspaceId: "w", actorUserId: "u" };
const all = (db: InMemoryFirestore, table: string) => db.query(table, []).map((item) => item.data()!);
const JOB_LIMITS = LIMITS.analysisJobs as { validStatusTransitions: Record<string, string[]>; idempotencyKeyParts: Record<string, number[]>; maxIdempotencyKeyLength: number; maxPayloadBytes: number };
const RULE_VERSION_LIMITS = LIMITS.ruleVersions as { maxContentBytes: number; maxRationaleBytes: number; maxAiSummaryBytes: number; maxDriftFindingIds: number };
const MAX_EVIDENCE_PER_VERSION = (LIMITS.limits as { maxEvidencePerVersion: number }).maxEvidencePerVersion;
function buildKey(type: string, segments: number): string {
  const rest = Array.from({ length: segments - 1 }, (_, i) => (type === "purge" && segments === 4 && i === 0) ? "subject" : `s${i}`);
  return [type, ...rest].join(":");
}

test("ANALYSIS_JOB_TYPES and UNIQUE_KEY_KINDS literal unions do not drift from the shared enum contract", () => {
  assert.deepEqual([...UNIQUE_KEY_KINDS], ENUMS["unique_keys.kind"]);
  assert.deepEqual([...ANALYSIS_JOB_TYPES], ENUMS["analysis_jobs.type"]);
});

test("job status transitions accepted by updateAnalysisJobStatus exactly match the contract table", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  db.put("projects/p", { id: "p", ownerWorkspaceId: ctx.workspaceId, status: "active", deletedAt: null });
  const statuses = ENUMS["analysis_jobs.status"];
  const accepted: [string, string][] = [];
  let n = 0;
  for (const from of statuses) {
    for (const to of statuses) {
      const id = `job-${n++}`;
      await store.runTransaction(async (tx) => tx.create(store.documentRef("analysis_jobs", id), { id, ownerWorkspaceId: ctx.workspaceId, projectId: "p", type: "bootstrap", status: from, attempts: 0, idempotencyKey: `bootstrap:${id}`, error: null, warnings: [], warningsOverflow: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }));
      try {
        await store.updateAnalysisJobStatus(ctx, id, to as AnalysisJobStatus);
        accepted.push([from, to]);
      } catch (error) {
        assert.ok(error instanceof RuleStoreError); assert.equal((error as RuleStoreError).code, "INVALID_STATUS_TRANSITION"); assert.equal((error as RuleStoreError).status, 422);
      }
    }
  }
  const expected: [string, string][] = [];
  for (const [from, tos] of Object.entries(JOB_LIMITS.validStatusTransitions)) for (const to of tos) expected.push([from, to]);
  assert.deepEqual(accepted.map((pair) => pair.join(":")).sort(), expected.map((pair) => pair.join(":")).sort());
});

test("validateAnalysisJobInput enforces the contract's idempotency-key length, payload size, and per-type segment counts", () => {
  const okKey = `bootstrap:${"a".repeat(JOB_LIMITS.maxIdempotencyKeyLength - "bootstrap:".length)}`;
  assert.equal(okKey.length, JOB_LIMITS.maxIdempotencyKeyLength);
  assert.doesNotThrow(() => validateAnalysisJobInput({ type: "bootstrap", projectId: "p", payload: { x: 1 }, idempotencyKey: okKey }));
  assert.throws(() => validateAnalysisJobInput({ type: "bootstrap", projectId: "p", payload: { x: 1 }, idempotencyKey: `${okKey}a` }), (e: RuleStoreError) => e.code === "INVALID_IDEMPOTENCY_KEY");

  const overhead = Buffer.byteLength(canonicalJson({ x: "" }), "utf8");
  const oversizedPayload = { x: "x".repeat(JOB_LIMITS.maxPayloadBytes - overhead + 1) };
  assert.throws(() => validateAnalysisJobInput({ type: "bootstrap", projectId: "p", payload: oversizedPayload, idempotencyKey: "bootstrap:p" }), (e: RuleStoreError) => e.code === "PAYLOAD_TOO_LARGE");

  for (const [type, counts] of Object.entries(JOB_LIMITS.idempotencyKeyParts) as [AnalysisJobType, number[]][]) {
    for (const n of counts) assert.doesNotThrow(() => validateAnalysisJobInput({ type, projectId: type === "purge" ? undefined : "p", payload: { x: 1 }, idempotencyKey: buildKey(type, n) }), `${type} with ${n} segments should be accepted`);
    assert.throws(() => validateAnalysisJobInput({ type, projectId: type === "purge" ? undefined : "p", payload: { x: 1 }, idempotencyKey: buildKey(type, Math.max(...counts) + 1) }), (e: RuleStoreError) => e.code === "INVALID_IDEMPOTENCY_KEY", `${type} with one extra segment should be rejected`);
  }
});

test("validateRuleVersionInput enforces the contract's byte and array-length limits", () => {
  const base = { content: "c", rationale: "r", changeType: "initial", evidenceIds: [] as string[], driftFindingIds: [] as string[] };
  const contentOk = "x".repeat(RULE_VERSION_LIMITS.maxContentBytes);
  assert.doesNotThrow(() => validateRuleVersionInput({ ...base, content: contentOk }));
  assert.throws(() => validateRuleVersionInput({ ...base, content: `${contentOk}x` }), (e: RuleStoreError) => e.code === "INVALID_CONTENT");

  const evidenceOk = Array.from({ length: MAX_EVIDENCE_PER_VERSION }, (_, i) => `e${i}`);
  assert.doesNotThrow(() => validateRuleVersionInput({ ...base, evidenceIds: evidenceOk }));
  assert.throws(() => validateRuleVersionInput({ ...base, evidenceIds: [...evidenceOk, "extra"] }), (e: RuleStoreError) => e.code === "INVALID_EVIDENCE_IDS");

  assert.throws(() => validateRuleVersionInput({ ...base, driftFindingIds: Array.from({ length: RULE_VERSION_LIMITS.maxDriftFindingIds + 1 }, (_, i) => `f${i}`) }), (e: RuleStoreError) => e.code === "INVALID_RULE_VERSION");
  assert.throws(() => validateRuleVersionInput({ ...base, aiSummary: "x".repeat(RULE_VERSION_LIMITS.maxAiSummaryBytes + 1) }), (e: RuleStoreError) => e.code === "INVALID_AI_SUMMARY");
  assert.throws(() => validateRuleVersionInput({ ...base, rationale: "x".repeat(RULE_VERSION_LIMITS.maxRationaleBytes + 1) }), (e: RuleStoreError) => e.code === "INVALID_RATIONALE");
});

test("linkRepository stores repository defaults from the shared contract, not a shared array reference", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  await store.runTransaction(async (tx) => tx.create(store.documentRef("installations", "i"), { id: "i", ownerWorkspaceId: ctx.workspaceId, status: "active", repositorySelection: "selected" }));
  const repository = await store.linkRepository(ctx, { projectId: "p", installationId: "i", githubRepoId: "100", fullName: "acme/api", githubOwnerLogin: "acme", defaultBranch: "main", requestId: "r" });
  const repositoryLimits = LIMITS.repositories as { rulesPath: string; compileTargets: string[] };
  assert.equal(repository.rulesPath, repositoryLimits.rulesPath);
  assert.deepEqual(repository.compileTargets, repositoryLimits.compileTargets);
  assert.notStrictEqual(repository.compileTargets, repositoryLimits.compileTargets);
});

test("installation.deleted tombstones every table in the uninstall contract and schedules purge using the contract grace period", async () => {
  const api: GitHubAppApiClient = { getInstallation: async () => { throw new Error("unused"); }, listInstallationRepositories: async () => [], createInstallationAccessToken: async () => ({ token: "x", expires_at: "" }) };
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api);
  const created = { action: "created", installation: { id: "i", account: { id: "org", login: "o", type: "Organization" as const }, repository_selection: "selected" as const }, sender: { id: "u", login: "u" } };
  const send = async (body: unknown, delivery: string) => { const raw = JSON.stringify(body); return service.receiveWebhook(new Request("https://x", { method: "POST", headers: { "x-github-event": "installation", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", "s").update(raw).digest("hex")}` }, body: raw }), "s"); };
  await send(created, "c");
  const workspaceId = String(all(db, "installations")[0]!.ownerWorkspaceId);
  const tables = (LIMITS.uninstall as { tombstoneTables: string[] }).tombstoneTables;
  await store.runTransaction(async (tx) => { for (const table of tables) tx.create(store.documentRef(table, `${table}-doc`), { id: `${table}-doc`, ownerWorkspaceId: workspaceId, deletedAt: null }); });
  await send({ ...created, action: "deleted" }, "d");
  const installation = all(db, "installations")[0]!;
  const gracePeriodDays = (LIMITS.retentionClass as { uninstallGracePeriodDays: number }).uninstallGracePeriodDays;
  assert.equal(Date.parse(String(installation.purgeScheduledAt)) - Date.parse(String(installation.deletedAt)), gracePeriodDays * 86400000);
  for (const table of tables) assert.equal(all(db, table)[0]!.deletedAt, installation.deletedAt);
});
