// Run after `npm run build`. This exercises the emitted production route bundles
// against a RuleStoreError created by the independently emitted runtime bundle.
// All storage and service I/O is stubbed.
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");

const secret = "diagnostic-error-boundary-secret";
const signSession = (userId) => {
  const body = Buffer.from(JSON.stringify({ userId, issuedAt: Date.now() })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const request = (path, body) => new Request(`https://example${path}`, {
  method: "POST",
  headers: {
    cookie: `rulebranch_session=${signSession("diagnostic-user")}`,
    "content-type": "application/json",
    "x-requested-with": "RuleBranch",
  },
  body: JSON.stringify(body),
});

async function main() {
  globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;
  Object.assign(process.env, {
    NEXT_RUNTIME: "nodejs",
    FIRESTORE_PROJECT_ID: "diagnostic-no-network",
    RULEBRANCH_SESSION_SECRET: secret,
    GOOGLE_CLOUD_PROJECT: "diagnostic-no-network",
  });
  await require("../.next/server/instrumentation.js").register();
  const runtime = globalThis.__rulebranchRuntime;

  let runtimeError;
  try {
    await runtime.store.reserveUniqueKey(
      { get: async () => ({ exists: true }) },
      "project_slug",
      { ownerWorkspaceId: "diagnostic-workspace", slug: "duplicate" },
      { targetTable: "projects", targetId: "unused" },
    );
  } catch (error) {
    runtimeError = error;
  }
  assert(runtimeError, "runtime bundle must produce the diagnostic RuleStoreError");
  assert.equal(runtimeError.code, "UNIQUE_VIOLATION");

  runtime.projectRepositories = { createProject: async () => { throw runtimeError; } };
  const projects = require("../.next/server/app/api/projects/route.js").routeModule.userland;
  const duplicate = await projects.POST(request("/api/projects", { ownerWorkspaceId: "diagnostic-workspace", slug: "duplicate" }));
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    error: "UNIQUE_VIOLATION",
    details: { kind: "project_slug", value: "diagnostic-workspace:duplicate" },
  });

  const RuntimeRuleStoreError = runtimeError.constructor;
  runtime.rules.createRuleVersion = async () => { throw new RuntimeRuleStoreError("SUPERSEDES_INVALID", 422); };
  const versions = require("../.next/server/app/api/rule-versions/route.js").routeModule.userland;
  const stale = await versions.POST(request("/api/rule-versions", {
    ownerWorkspaceId: "diagnostic-workspace",
    ruleId: "diagnostic-rule",
    supersedes: "stale-version",
  }));
  assert.equal(stale.status, 422);
  assert.deepEqual(await stale.json(), { error: "SUPERSEDES_INVALID", details: {} });

  runtime.rules.createRuleVersion = async () => { throw { code: "SUPERSEDES_INVALID", status: 422, details: {} }; };
  const unknown = await versions.POST(request("/api/rule-versions", {
    ownerWorkspaceId: "diagnostic-workspace",
    ruleId: "diagnostic-rule",
  }));
  assert.equal(unknown.status, 500);
  assert.deepEqual(await unknown.json(), { error: "INTERNAL_ERROR" });

  console.log("Built error boundaries: runtime-bundle errors returned duplicate-project 409 and stale-supersedes 422; unbranded lookalike returned 500.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
