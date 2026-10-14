import assert from "node:assert/strict";
import test from "node:test";
import { githubRepositoryUrl } from "../src/lib/github-repository-url.ts";

test("repository url is built from an owner and repository slug", () => {
  assert.equal(githubRepositoryUrl("yunbow/rule-branch"),
    "https://github.com/yunbow/rule-branch");
  assert.equal(githubRepositoryUrl("Example.Tools/My_repo.dev"),
    "https://github.com/Example.Tools/My_repo.dev");
});

test("untrusted or malformed repository names cannot become external links", () => {
  for (const invalid of ["", "owner", "owner/repo/extra", "owner//repo", "owner/<script>",
    "https://evil.example.com/x", "owner/repo?redirect=true", "owner/repo#anchor"]) {
    assert.equal(githubRepositoryUrl(invalid), null, invalid);
  }
});
