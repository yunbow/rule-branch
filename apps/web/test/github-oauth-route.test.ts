import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/auth/github/route.ts";

test("GitHub OAuth start redirects and writes state plus the exact safe continuation", async () => {
  const previous = process.env.GITHUB_OAUTH_CLIENT_ID;
  const previousPublicUrl = process.env.RULEBRANCH_PUBLIC_URL;
  process.env.GITHUB_OAUTH_CLIENT_ID = "test-client-id";
  process.env.RULEBRANCH_PUBLIC_URL = "https://rulebranch.example";
  try {
    const response = await GET(new Request("https://rulebranch.example/api/auth/github?next=%2Fw%2Fworkspace-1%2Fprojects%2Fproject-1%3Ftab%3Drules%26filter%3Da%252Fb"));
    const location = new URL(response.headers.get("location")!);
    assert.equal(response.status, 302);
    assert.equal(location.origin, "https://github.com");
    assert.equal(location.pathname, "/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "test-client-id");
    assert.equal(location.searchParams.get("redirect_uri"), "https://rulebranch.example/api/auth/github/callback");
    assert.match(response.headers.get("set-cookie")!, /^rulebranch_oauth_state=[\w-]+; HttpOnly;/);
    assert.match(response.headers.get("set-cookie")!, /rulebranch_oauth_next=%2Fw%2Fworkspace-1%2Fprojects%2Fproject-1%3Ftab%3Drules%26filter%3Da%252Fb/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = previous;
    if (previousPublicUrl === undefined) delete process.env.RULEBRANCH_PUBLIC_URL;
    else process.env.RULEBRANCH_PUBLIC_URL = previousPublicUrl;
  }
});
