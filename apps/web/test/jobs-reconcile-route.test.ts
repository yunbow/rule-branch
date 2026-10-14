import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/internal/jobs-reconcile/route.ts";
import { buildRuntime } from "../src/server/bootstrap.ts";
import { EnqueueingRuleStore } from "../src/shared/enqueueing-rulestore.ts";
import { configureRuntime } from "../src/shared/runtime.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const env = { FIRESTORE_PROJECT_ID: "p", RULEBRANCH_SESSION_SECRET: "s", GOOGLE_CLOUD_PROJECT: "p", CLOUD_TASKS_LOCATION: "l", CLOUD_TASKS_QUEUE: "q", WORKER_URL: "https://worker", WORKER_SERVICE_ACCOUNT_EMAIL: "worker@example.com" };
const request = (token?: string) => new Request("https://web/api/internal/jobs-reconcile", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

test("reconcile route uses the runtime dispatch capability with OIDC authentication", async () => {
  const db = new InMemoryFirestore(), runtime = buildRuntime(env, () => db)!;
  const job = { id: "stale", ownerWorkspaceId: "w", projectId: "p", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" };
  db.put("projects/p", { id: "p", ownerWorkspaceId: "w", status: "active", deletedAt: null });
  await runtime.store!.runTransaction(async (tx) => tx.create(runtime.store!.documentRef("analysis_jobs", job.id), job));
  const dispatched: string[] = [];
  (runtime.store as EnqueueingRuleStore).redispatch = async (job) => { dispatched.push(job.id); };
  runtime.schedulerOidcVerifier = { verify: (token) => token === "good" };
  configureRuntime(runtime);
  assert.equal((await POST(request())).status, 401);
  assert.equal((await POST(request("bad"))).status, 403);
  assert.deepEqual(dispatched, []);
  const response = await POST(request("good"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { redispatched: 1, failed: 0 });
  assert.deepEqual(dispatched, [job.id]);
});

test("reconcile route reports missing dispatch configuration instead of false success", async () => {
  configureRuntime(buildRuntime({ FIRESTORE_PROJECT_ID: "p", RULEBRANCH_SESSION_SECRET: "s" }, () => new InMemoryFirestore())!);
  const response = await POST(request("good"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "JOB_DISPATCH_NOT_CONFIGURED" });
});
