import test from "node:test";
import assert from "node:assert/strict";
import { FirestoreRuleStore, RuleStoreError, sha256HexString } from "../src/shared/rulestore.ts";
import { enqueueAnalysisJob, getJob, listProjectJobs, submitAnalysisJob } from "../src/shared/analysis-jobs.ts";
import { FakeCloudTasksClient } from "./fake-cloud-tasks.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";
const ctx = { workspaceId: "w", actorUserId: "u" }; const input = { type: "bootstrap" as const, projectId: "p", payload: { x: 1 }, idempotencyKey: "bootstrap:p", requestId: "r" };
const jobStore = (...projectIds: string[]) => { const db = new InMemoryFirestore(); for (const id of projectIds) db.put(`projects/${id}`, { id, ownerWorkspaceId: "w", status: "active", deletedAt: null }); return { db, store: new FirestoreRuleStore(db) }; };
test("analysis job creation is idempotent, validates input, and exposes tenant APIs", async () => {
  const { store } = jobStore("p"); const [a, b] = await Promise.all([store.createAnalysisJob(ctx, input), store.createAnalysisJob(ctx, input)]);
  assert.equal(a.job.id, b.job.id); assert.equal(Number(a.created) + Number(b.created), 1); assert.equal((await listProjectJobs(store, ctx, "p")).length, 1); assert.equal((await getJob(store, { ...ctx, workspaceId: "other" }, a.job.id)), null);
  assert.deepEqual(await submitAnalysisJob(store, ctx, input), { status: 202, jobId: a.job.id });
  await assert.rejects(store.createAnalysisJob(ctx, { ...input, idempotencyKey: "wrong:p" }), (e: RuleStoreError) => e.status === 422);
  await assert.rejects(store.createAnalysisJob(ctx, { ...input, payload: { x: "x".repeat(65 * 1024) } }), (e: RuleStoreError) => e.code === "PAYLOAD_TOO_LARGE");
});
test("analysis job idempotency never follows a colliding reservation across workspaces", async () => {
  const { db, store } = jobStore("p");
  db.put("projects/other-p", { id: "other-p", ownerWorkspaceId: "other", status: "active", deletedAt: null });
  const first = await store.createAnalysisJob(ctx, input);
  await assert.rejects(store.createAnalysisJob({ workspaceId: "other", actorUserId: "other-user" }, { ...input, projectId: "other-p" }), (error: RuleStoreError) => error.code === "UNIQUE_VIOLATION");
  assert.equal(first.job.ownerWorkspaceId, "w");
});
test("done retains key while dead releases it in status transaction", async () => {
  const { db, store } = jobStore("p", "q"); const first = await store.createAnalysisJob(ctx, input); await store.updateAnalysisJobStatus(ctx, first.job.id, "running"); await store.updateAnalysisJobStatus(ctx, first.job.id, "done"); assert.equal((await store.createAnalysisJob(ctx, input)).job.id, first.job.id);
  const failed = await store.createAnalysisJob(ctx, { ...input, idempotencyKey: "bootstrap:q", projectId: "q" }); for (let i = 0; i < 5; i += 1) { await store.updateAnalysisJobStatus(ctx, failed.job.id, "running"); await store.updateAnalysisJobStatus(ctx, failed.job.id, "failed"); }
  assert.equal((await getJob(store, ctx, failed.job.id))!.status, "dead"); assert.equal(await store.get(ctx, "unique_keys", `job_idempotency:${sha256HexString("bootstrap:q")}`), null); assert.equal((await store.createAnalysisJob(ctx, { ...input, idempotencyKey: "bootstrap:q", projectId: "q" })).created, true);
});
test("Cloud Tasks task name survives idempotencyKey reuse after a dead job releases it", async () => {
  const { db, store } = jobStore("r"); const client = new FakeCloudTasksClient();
  const dead = await store.createAnalysisJob(ctx, { ...input, idempotencyKey: "bootstrap:r", projectId: "r" });
  await enqueueAnalysisJob(client, "projects/x/locations/y/queues/q", "https://worker/tasks/analysis-jobs", "https://worker", "task@example.com", dead.job);
  for (let i = 0; i < 5; i += 1) { await store.updateAnalysisJobStatus(ctx, dead.job.id, "running"); await store.updateAnalysisJobStatus(ctx, dead.job.id, "failed"); }
  assert.equal((await getJob(store, ctx, dead.job.id))!.status, "dead");
  const revived = await store.createAnalysisJob(ctx, { ...input, idempotencyKey: "bootstrap:r", projectId: "r" });
  assert.notEqual(revived.job.id, dead.job.id);
  await enqueueAnalysisJob(client, "projects/x/locations/y/queues/q", "https://worker/tasks/analysis-jobs", "https://worker", "task@example.com", revived.job);
  assert.equal(client.tasks.length, 2); assert.notEqual(client.tasks[0].name, client.tasks[1].name);
});
test("warnings retain twenty and Cloud Tasks duplicate task is success", async () => {
  const { store } = jobStore("p"); const result = await store.createAnalysisJob(ctx, input); await store.updateAnalysisJobStatus(ctx, result.job.id, "running"); const warnings = Array.from({ length: 21 }, (_, i) => ({ code: "schema_retry" as const, message: String(i) })); const job = await store.updateAnalysisJobStatus(ctx, result.job.id, "done", { warnings }); assert.equal((job.warnings as unknown[]).length, 20); assert.equal(job.warningsOverflow, 1);
  const client = new FakeCloudTasksClient(); await enqueueAnalysisJob(client, "projects/x/locations/y/queues/q", "https://worker/tasks/analysis-jobs", "https://worker", "task@example.com", result.job); await enqueueAnalysisJob(client, "projects/x/locations/y/queues/q", "https://worker/tasks/analysis-jobs", "https://worker", "task@example.com", result.job); assert.match(client.tasks[0].name, new RegExp(`${sha256HexString(result.job.id)}$`)); assert.equal(client.tasks[0].httpRequest.url, "https://worker/tasks/analysis-jobs"); assert.equal(client.tasks[0].httpRequest.oidcToken?.audience, "https://worker"); assert.deepEqual(JSON.parse(Buffer.from(client.tasks[0].httpRequest.body).toString()), { jobId: result.job.id, workspaceId: result.job.ownerWorkspaceId });
});
