import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntime } from "../src/server/bootstrap.ts";
import { EnqueueingRuleStore } from "../src/shared/enqueueing-rulestore.ts";
import { FirestoreRuleStore, type AnalysisJob } from "../src/shared/rulestore.ts";
import { FakeCloudTasksClient } from "./fake-cloud-tasks.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const ctx = { workspaceId: "w", actorUserId: "u" }, input = { type: "bootstrap" as const, projectId: "p", payload: {}, idempotencyKey: "bootstrap:p", requestId: "r" };
test("production runtime rejects weak session secrets and unsafe OAuth public URLs", () => {
  const base = { FIRESTORE_PROJECT_ID: "p", NODE_ENV: "production", GITHUB_OAUTH_CLIENT_ID: "client", GITHUB_OAUTH_CLIENT_SECRET: "secret" };
  assert.throws(() => buildRuntime({ ...base, RULEBRANCH_SESSION_SECRET: "short", RULEBRANCH_PUBLIC_URL: "https://rulebranch.example" }, () => new InMemoryFirestore()), /at least 32 bytes/);
  assert.throws(() => buildRuntime({ FIRESTORE_PROJECT_ID: "p", NODE_ENV: "production", RULEBRANCH_SESSION_SECRET: "s".repeat(32), GITHUB_OAUTH_CLIENT_ID: "client" }, () => new InMemoryFirestore()), /configured together/);
  assert.throws(() => buildRuntime({ ...base, RULEBRANCH_SESSION_SECRET: "s".repeat(32), RULEBRANCH_PUBLIC_URL: "http:\/\/rulebranch.example" }, () => new InMemoryFirestore()), /HTTPS origin/);
  assert.throws(() => buildRuntime({ ...base, RULEBRANCH_SESSION_SECRET: "s".repeat(32) }, () => new InMemoryFirestore()), /must be configured/);
  assert.ok(buildRuntime({ FIRESTORE_PROJECT_ID: "p", NODE_ENV: "production", RULEBRANCH_SESSION_SECRET: "s".repeat(32) }, () => new InMemoryFirestore()));
  assert.ok(buildRuntime({ ...base, RULEBRANCH_SESSION_SECRET: "s".repeat(32), RULEBRANCH_PUBLIC_URL: "https://rulebranch.example" }, () => new InMemoryFirestore()));
});
test("EnqueueingRuleStore retries queued jobs and propagates enqueue failures", async () => {
  const db = new InMemoryFirestore(), tasks = new FakeCloudTasksClient(); let calls = 0;
  for (const id of ["p", "q"]) db.put(`projects/${id}`, { id, ownerWorkspaceId: "w", status: "active", deletedAt: null });
  const client = { createTask: async (request: Parameters<FakeCloudTasksClient["createTask"]>[0]) => { calls += 1; await tasks.createTask(request); } };
  const store = new EnqueueingRuleStore(db, { client, parent: "projects/p/locations/l/queues/q", taskUrl: "https://worker/tasks/analysis-jobs", audience: "https://worker", serviceAccountEmail: "tasks@example.com" });
  const first = await store.createAnalysisJob(ctx, input); await store.createAnalysisJob(ctx, input);
  assert.equal(tasks.tasks.length, 1); assert.equal(calls, 2); assert.equal(first.created, true); assert.equal(tasks.tasks[0].httpRequest.url, "https://worker/tasks/analysis-jobs"); assert.equal(tasks.tasks[0].httpRequest.oidcToken?.audience, "https://worker");
  const broken = new EnqueueingRuleStore(db, { client: { createTask: async () => { throw new Error("temporary"); } }, parent: "p", taskUrl: "https://worker/tasks/analysis-jobs", audience: "https://worker", serviceAccountEmail: "tasks@example.com" });
  await assert.rejects(broken.createAnalysisJob(ctx, { ...input, projectId: "q", idempotencyKey: "bootstrap:q" }), /temporary/);
  const [queued] = await broken.list(ctx, "analysis_jobs", { projectId: "q" });
  assert.equal(queued?.status, "queued");
  // The write already committed (createAnalysisJob's job document, distinct from the failed
  // Cloud Tasks call), so recovery redispatches the same still-queued job rather than
  // creating a new one.
  const recovered = new EnqueueingRuleStore(db, { client, parent: "projects/p/locations/l/queues/q", taskUrl: "https://worker/tasks/analysis-jobs", audience: "https://worker", serviceAccountEmail: "tasks@example.com" });
  await recovered.redispatch(queued as unknown as AnalysisJob);
  assert.equal(tasks.tasks.length, 2); assert.notEqual(tasks.tasks[0].name, tasks.tasks[1].name);
});
test("buildRuntime keeps missing configuration unconfigured and composes optional integrations", () => {
  assert.equal(buildRuntime({}), undefined); assert.equal(buildRuntime({ FIRESTORE_PROJECT_ID: "p" }), undefined);
  const plain = buildRuntime({ FIRESTORE_PROJECT_ID: "p", RULEBRANCH_SESSION_SECRET: "s" }, () => new InMemoryFirestore())!;
  assert.ok(plain.store instanceof FirestoreRuleStore); assert.ok(!(plain.store instanceof EnqueueingRuleStore)); assert.equal(plain.githubApp, undefined);
  assert.equal(plain.redispatchAnalysisJob, undefined);
  const app = buildRuntime({ FIRESTORE_PROJECT_ID: "p", RULEBRANCH_SESSION_SECRET: "s", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "key", GITHUB_WEBHOOK_SECRET: "secret" }, () => new InMemoryFirestore())!;
  assert.ok(app.githubApp); assert.ok(app.projectRepositories);
});
