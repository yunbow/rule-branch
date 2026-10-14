import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { loginPathForContinuation, safeRelativeUrl, unauthenticatedLoginRedirect } from "../src/shared/auth-navigation.ts";
import { proxy } from "../src/proxy.ts";

test("protected login redirect preserves the parsed path and query exactly once", () => {
  const response = unauthenticatedLoginRedirect(
    new URL("https://attacker.example/w/workspace-1/projects/project-1?tab=rules&filter=a%2Fb&q=%E6%97%A5%E6%9C%AC"),
  );

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "/login?next=%2Fw%2Fworkspace-1%2Fprojects%2Fproject-1%3Ftab%3Drules%26filter%3Da%252Fb%26q%3D%25E6%2597%25A5%25E6%259C%25AC",
  );
  assert.doesNotMatch(response.headers.get("location") ?? "", /attacker\.example/);
});

test("safe continuation accepts local path/query and rejects open redirect forms", () => {
  assert.equal(safeRelativeUrl("/w/workspace-1/projects/new?installation=123%2F456"), "/w/workspace-1/projects/new?installation=123%2F456");
  for (const unsafe of [
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/%2fevil.example/path",
    "/path%0d%0aLocation:%20https://evil.example",
  ]) assert.equal(safeRelativeUrl(unsafe), null, unsafe);
});

test("protected route proxy overwrites a spoofed continuation with its parsed path and query", () => {
  const response = proxy(new NextRequest("https://untrusted.example/w/workspace-1/projects/project-1?tab=rules&filter=a%2Fb", {
    headers: { "x-rulebranch-request-target": "//evil.example" },
  }));
  assert.equal(
    response.headers.get("x-middleware-request-x-rulebranch-request-target"),
    "/w/workspace-1/projects/project-1?tab=rules&filter=a%2Fb",
  );
  assert.equal(
    loginPathForContinuation(response.headers.get("x-middleware-request-x-rulebranch-request-target")),
    "/login?next=%2Fw%2Fworkspace-1%2Fprojects%2Fproject-1%3Ftab%3Drules%26filter%3Da%252Fb",
  );
});
