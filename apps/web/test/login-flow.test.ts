import assert from "node:assert/strict";
import test from "node:test";
import type { AuthService } from "../src/shared/auth.ts";
import { createAuthHandlers } from "../src/shared/http-api.ts";

const auth = {
  loginWithCode: async () => ({ id: "user-1" }),
} as unknown as AuthService;

test("login callback sends invalid state back to the login UI", async () => {
  const response = await createAuthHandlers(auth, "secret").callback(
    new Request("https://rulebranch.test/api/auth/github/callback?state=wrong", {
      headers: { cookie: "rulebranch_oauth_state=expected" },
    }),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://rulebranch.test/login?error=OAUTH_STATE_MISMATCH");
});

test("login callback preserves an internal continuation after authentication", async () => {
  const response = await createAuthHandlers(auth, "secret").callback(
    new Request("https://rulebranch.test/api/auth/github/callback?state=state-1&code=code-1", {
      headers: {
        cookie: "rulebranch_oauth_state=state-1; rulebranch_oauth_next=%2Fw%2Fworkspace-1%2Fprojects%2Fnew",
      },
    }),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://rulebranch.test/w/workspace-1/projects/new");
  assert.match(response.headers.get("set-cookie") ?? "", /rulebranch_session=/);
});

test("login callback preserves escaped path and query and ignores an untrusted callback host", async () => {
  const previousPublicUrl = process.env.RULEBRANCH_PUBLIC_URL;
  process.env.RULEBRANCH_PUBLIC_URL = "https://rulebranch.example";
  try {
    const next = "/w/workspace-1/projects/project-1?tab=rules&filter=a%2Fb&q=%E6%97%A5%E6%9C%AC";
    const response = await createAuthHandlers(auth, "secret").callback(
      new Request("https://attacker.example/api/auth/github/callback?state=state-1&code=code-1", {
        headers: {
          host: "attacker.example",
          cookie: `rulebranch_oauth_state=state-1; rulebranch_oauth_next=${encodeURIComponent(next)}`,
        },
      }),
    );
    assert.equal(response.headers.get("location"), `https://rulebranch.example${next}`);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.RULEBRANCH_PUBLIC_URL;
    else process.env.RULEBRANCH_PUBLIC_URL = previousPublicUrl;
  }
});

test("login callback rejects an external continuation and falls back to the app root", async () => {
  const response = await createAuthHandlers(auth, "secret").callback(
    new Request("https://rulebranch.test/api/auth/github/callback?state=state-1&code=code-1", {
      headers: {
        cookie: "rulebranch_oauth_state=state-1; rulebranch_oauth_next=https%3A%2F%2Fevil.example",
      },
    }),
  );
  assert.equal(response.headers.get("location"), "https://rulebranch.test/");
});

test("login callback rejects a backslash-normalized external continuation", async () => {
  const response = await createAuthHandlers(auth, "secret").callback(
    new Request("https://rulebranch.test/api/auth/github/callback?state=state-1&code=code-1", {
      headers: {
        cookie: "rulebranch_oauth_state=state-1; rulebranch_oauth_next=%2F%5Cevil.example",
      },
    }),
  );
  assert.equal(response.headers.get("location"), "https://rulebranch.test/");
});

test("cancelled GitHub authorization returns an actionable login error and keeps next", async () => {
  const response = await createAuthHandlers(auth, "secret").callback(
    new Request("https://rulebranch.test/api/auth/github/callback?state=state-1&error=access_denied", {
      headers: {
        cookie: "rulebranch_oauth_state=state-1; rulebranch_oauth_next=%2Fw%2Fworkspace-1",
      },
    }),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://rulebranch.test/login?error=OAUTH_CANCELLED&next=%2Fw%2Fworkspace-1");
});
