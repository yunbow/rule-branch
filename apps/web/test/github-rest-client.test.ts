import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRestApiClient } from "../src/shared/auth.ts";

test("GitHub REST requests identify RuleBranch with a User-Agent", async () => {
  const requests: RequestInit[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {});
    return Response.json({ id: 1, login: "octocat" });
  }) as typeof fetch;
  const client = new GitHubRestApiClient("client-id", "client-secret", fetchImpl);

  await client.getAuthenticatedUser("access-token");
  await client.getUserByLogin("octocat");

  for (const request of requests) {
    const headers = new Headers(request.headers);
    assert.equal(headers.get("user-agent"), "RuleBranch/1.0");
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  }
});

test("GitHub OAuth token exchange uses the same registered callback URL", async () => {
  let request: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return Response.json({ access_token: "token" });
  }) as typeof fetch;
  const client = new GitHubRestApiClient("client-id", "client-secret", fetchImpl, "https://rulebranch.example/api/auth/github/callback");

  await client.exchangeCodeForToken("code");

  assert.deepEqual(JSON.parse(String(request?.body)), { client_id: "client-id", client_secret: "client-secret", code: "code", redirect_uri: "https://rulebranch.example/api/auth/github/callback" });
});
