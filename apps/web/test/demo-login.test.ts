import assert from "node:assert/strict";
import test from "node:test";
import { createJudgeDemoLoginHandlers, JUDGE_DEMO, JudgeDemoLoginRateLimiter } from "../src/shared/demo-auth.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";
import { verifySession } from "../src/shared/auth.ts";

const env = {
  RULEBRANCH_DEMO_LOGIN_ENABLED: "1",
  RULEBRANCH_DEMO_LOGIN_ID: "judge",
  RULEBRANCH_DEMO_LOGIN_PASSWORD: "demo-password",
};

function request(id: string, password: string) {
  return new Request("https://rulebranch.test/api/auth/demo-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "RuleBranch",
    },
    body: JSON.stringify({ id, password }),
  });
}

function handlers(store: FirestoreRuleStore, limiter = new JudgeDemoLoginRateLimiter()) {
  return createJudgeDemoLoginHandlers(store, "session-secret", env, limiter);
}

function rawRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("https://rulebranch.test/api/auth/demo-login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "RuleBranch",
      ...headers,
    },
    body,
  });
}

test("judge demo login rejects invalid credentials without provisioning data", async () => {
  const firestore = new InMemoryFirestore({ enforceReadBeforeWrite: true });
  const store = new FirestoreRuleStore(firestore);
  const response = await handlers(store).login(request("judge", "wrong"));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "INVALID_DEMO_CREDENTIALS" });
  assert.equal(firestore.getStored("users", JUDGE_DEMO.userId), undefined);
});

test("judge demo login provisions a read-only workspace and starts a session", async () => {
  const firestore = new InMemoryFirestore({ enforceReadBeforeWrite: true });
  const store = new FirestoreRuleStore(firestore);
  const response = await handlers(store).login(request("judge", "demo-password"));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /rulebranch_session=/);
  assert.deepEqual(await response.json(), {
    userId: JUDGE_DEMO.userId,
    workspaceId: JUDGE_DEMO.workspaceId,
    projectId: JUDGE_DEMO.projectId,
    redirectTo: `/w/${JUDGE_DEMO.workspaceId}`,
    readOnly: true,
  });

  assert.equal(
    firestore.getStored("workspace_members", JUDGE_DEMO.memberId)?.data.role,
    "viewer",
  );
  assert.equal(
    firestore.getStored("repositories", JUDGE_DEMO.repositoryId)?.data.fullName,
    "yunbow/rule-branch-demo-workspace-1",
  );
  assert.equal(
    firestore.getStored("user_preferences", "judge-demo-preferences")?.data.userId,
    JUDGE_DEMO.userId,
  );
  assert.equal(
    firestore.getStored("rule_versions", "judge-demo-version-zod-v2")?.data.status,
    "proposed",
  );
  assert.equal(
    (firestore.getStored("rule_versions", "judge-demo-version-zod-v2")?.data.approvalReview as Record<string, unknown>)?.state,
    "human_required",
  );
});

test("judge demo login is idempotent and restores the fixed fixture", async () => {
  const firestore = new InMemoryFirestore({ enforceReadBeforeWrite: true });
  const store = new FirestoreRuleStore(firestore);
  const handler = handlers(store);

  assert.equal((await handler.login(request("judge", "demo-password"))).status, 200);
  firestore.put("projects/judge-demo-project", {
    ...firestore.getStored("projects", JUDGE_DEMO.projectId)!.data,
    name: "changed",
  });
  assert.equal((await handler.login(request("judge", "demo-password"))).status, 200);
  assert.equal(
    firestore.getStored("projects", JUDGE_DEMO.projectId)?.data.name,
    "RuleBranch Demo Workspace 1",
  );
});

test("judge demo login rejects malformed and non-object JSON without provisioning", async () => {
  const firestore = new InMemoryFirestore({ enforceReadBeforeWrite: true });
  const store = new FirestoreRuleStore(firestore);
  const handler = handlers(store);

  for (const body of ["null", "[]", "\"credentials\"", "{"]) {
    const response = await handler.login(rawRequest(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_DEMO_LOGIN_REQUEST" });
  }
  assert.equal(firestore.getStored("users", JUDGE_DEMO.userId), undefined);
});

test("judge demo login rejects request bodies larger than 4 KiB", async () => {
  const firestore = new InMemoryFirestore({ enforceReadBeforeWrite: true });
  const store = new FirestoreRuleStore(firestore);
  const response = await handlers(store).login(rawRequest(JSON.stringify({ id: "judge", password: "x".repeat(4_096) })));

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "INVALID_DEMO_LOGIN_REQUEST" });
  assert.equal(firestore.getStored("users", JUDGE_DEMO.userId), undefined);
});

test("judge demo login is disabled by default and enforces browser mutation headers", async () => {
  const store = new FirestoreRuleStore(new InMemoryFirestore());
  const disabled = await createJudgeDemoLoginHandlers(store, "session-secret", {}, new JudgeDemoLoginRateLimiter())
    .login(request("judge", "demo-password"));
  assert.equal(disabled.status, 404);

  const missingHeader = new Request("https://rulebranch.test/api/auth/demo-login", {
    method: "POST",
    body: JSON.stringify({ id: "judge", password: "demo-password" }),
  });
  assert.equal((await handlers(store).login(missingHeader)).status, 403);

  const crossOrigin = request("judge", "demo-password");
  crossOrigin.headers.set("Origin", "https://attacker.example");
  assert.equal((await handlers(store).login(crossOrigin)).status, 403);
});

test("judge demo login applies per-client rate limits and recovers after the window", async () => {
  let now = 1_000;
  const limiter = new JudgeDemoLoginRateLimiter(2, 1_000, 16, 20, () => now);
  const store = new FirestoreRuleStore(new InMemoryFirestore());
  const handler = handlers(store, limiter);
  const attempt = () => handler.login(rawRequest(JSON.stringify({ id: "judge", password: "wrong" }), {
    "X-Forwarded-For": "spoofed, 203.0.113.10, proxy",
  }));

  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 401);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");

  now += 1_001;
  assert.equal((await attempt()).status, 401);
});

test("judge demo login limiter bounds client buckets and has an aggregate cap", () => {
  const bounded = new JudgeDemoLoginRateLimiter(10, 60_000, 2, 100, () => 1_000);
  for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    assert.equal(bounded.take(new Request("https://rulebranch.test", { headers: { "X-Forwarded-For": ip } })).allowed, true);
  }
  assert.equal(bounded.size, 2);

  const aggregate = new JudgeDemoLoginRateLimiter(10, 60_000, 10, 2, () => 1_000);
  assert.equal(aggregate.take(new Request("https://rulebranch.test", { headers: { "X-Forwarded-For": "203.0.113.1" } })).allowed, true);
  assert.equal(aggregate.take(new Request("https://rulebranch.test", { headers: { "X-Forwarded-For": "203.0.113.2" } })).allowed, true);
  assert.deepEqual(
    aggregate.take(new Request("https://rulebranch.test", { headers: { "X-Forwarded-For": "203.0.113.3" } })),
    { allowed: false, retryAfterSeconds: 60 },
  );
});

test("judge demo session cookie is production-secure and rejects tampering", async () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previous = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = "production";
  try {
    const store = new FirestoreRuleStore(new InMemoryFirestore({ enforceReadBeforeWrite: true }));
    const response = await handlers(store).login(request("judge", "demo-password"));
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /Max-Age=86400/);
    const value = setCookie.match(/rulebranch_session=([^;]+)/)?.[1] ?? "";
    assert.equal(verifySession(`${value}x`, "session-secret"), null);
  } finally {
    if (previous === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previous;
  }
});
