import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SHELL_ME, loadShellMe } from "../src/lib/shell-me.ts";

test("the application shell loads shared account data once for both header consumers", async () => {
  let requests = 0;
  const expected = { workspaces: [{ id: "w", name: "Workspace", kind: "organization" as const, role: "viewer" }], pendingInvitations: 2 };
  const result = await loadShellMe(async () => { requests += 1; return expected; });
  assert.equal(requests, 1);
  assert.deepEqual(result, expected);
});

test("the application shell retains empty header fallbacks when account loading fails", async () => {
  let requests = 0;
  const result = await loadShellMe(async () => { requests += 1; throw new Error("unavailable"); });
  assert.equal(requests, 1);
  assert.deepEqual(result, EMPTY_SHELL_ME);
});
