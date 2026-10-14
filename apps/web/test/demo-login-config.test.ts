import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntime } from "../src/server/bootstrap.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const base = {
  NODE_ENV: "production",
  FIRESTORE_PROJECT_ID: "rulebranch-test",
  RULEBRANCH_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  RULEBRANCH_DEMO_LOGIN_ENABLED: "1",
};

test("production bootstrap rejects enabled demo login without credentials", () => {
  assert.throws(
    () => buildRuntime(base, () => new InMemoryFirestore()),
    /Judge demo login ID and password must be configured/,
  );
});

test("production bootstrap rejects a short demo password", () => {
  assert.throws(
    () => buildRuntime({
      ...base,
      RULEBRANCH_DEMO_LOGIN_ID: "zenn-judge",
      RULEBRANCH_DEMO_LOGIN_PASSWORD: "short",
    }, () => new InMemoryFirestore()),
    /at least 12 characters/,
  );
});

test("production bootstrap accepts configured demo credentials", () => {
  const runtime = buildRuntime({
    ...base,
    RULEBRANCH_DEMO_LOGIN_ID: "zenn-judge",
    RULEBRANCH_DEMO_LOGIN_PASSWORD: "long-demo-password",
  }, () => new InMemoryFirestore());

  assert.ok(runtime);
  assert.ok(runtime?.store);
});
