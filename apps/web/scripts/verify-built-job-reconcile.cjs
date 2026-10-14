// Run after `npm run build`. Separate production bundles must share the dispatch
// capability without relying on constructor identity. All I/O is stubbed.
const assert = require("node:assert/strict");

async function main() {
  globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;
  Object.assign(process.env, {
    NEXT_RUNTIME: "nodejs", FIRESTORE_PROJECT_ID: "diagnostic-no-network",
    RULEBRANCH_SESSION_SECRET: "diagnostic-no-network", GOOGLE_CLOUD_PROJECT: "diagnostic-no-network",
    CLOUD_TASKS_LOCATION: "asia-northeast1", CLOUD_TASKS_QUEUE: "rulebranch-worker",
    WORKER_URL: "https://worker.example", WORKER_SERVICE_ACCOUNT_EMAIL: "worker@example.com",
  });
  await require("../.next/server/instrumentation.js").register();
  const runtime = globalThis.__rulebranchRuntime;
  const dispatched = [];
  runtime.schedulerOidcVerifier = { verify: (token) => token === "good" };
  runtime.schedulerAudience = "diagnostic";
  runtime.store.reconcilePendingCompilations = async () => 0;
  runtime.store.findServerDocuments = async () => [{ id: "diagnostic-job", ownerWorkspaceId: "diagnostic-workspace", projectId: "diagnostic-project", createdAt: "2026-01-01T00:00:00.000Z", status: "queued" }];
  runtime.store.get = async (_ctx, collection, id) => collection === "projects" && id === "diagnostic-project" ? { id, ownerWorkspaceId: "diagnostic-workspace", status: "active", deletedAt: null } : null;
  runtime.store.redispatch = async (job) => { dispatched.push(job.id); };
  const { POST } = require("../.next/server/app/api/internal/jobs-reconcile/route.js").routeModule.userland;
  const request = (token) => new Request("https://example/api/internal/jobs-reconcile", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await POST(request())).status, 401);
  assert.equal((await POST(request("bad"))).status, 403);
  assert.deepEqual(dispatched, []);
  const response = await POST(request("good"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { redispatched: 1, failed: 0 });
  assert.deepEqual(dispatched, ["diagnostic-job"]);
  delete runtime.redispatchAnalysisJob;
  assert.equal((await POST(request("good"))).status, 503);
  console.log("Built reconcile route: OIDC checks passed; one stale job actually dispatched; missing configuration returns 503.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
