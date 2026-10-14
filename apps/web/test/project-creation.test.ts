import test from "node:test";
import assert from "node:assert/strict";
import { addProjectTag, normalizeProjectSlug, PROJECT_SLUG_PATTERN, suggestProjectSlug, validateProjectSlug } from "../src/lib/project-creation.ts";

test("slug suggestion accepts ASCII, fullwidth letters, and trims URL separators", () => {
  assert.equal(normalizeProjectSlug("  Web Application  "), "web-application");
  assert.equal(normalizeProjectSlug("ＡＢＣサービス"), "abc");
  assert.equal(normalizeProjectSlug("  _My.Project._  "), "my.project");
  assert.equal(normalizeProjectSlug("///"), "");
  assert.equal(normalizeProjectSlug("A".repeat(125)), "a".repeat(100));
});

test("Japanese-only project names use selected repository as a fallback", () => {
  assert.equal(suggestProjectSlug("社内システム", ["acme/internal-web"]), "internal-web");
  assert.equal(suggestProjectSlug("社内開発", ["acme/ＡＰＩ"]), "api");
  assert.equal(suggestProjectSlug("Auth API", ["acme/internal-web"]), "auth-api");
  assert.equal(suggestProjectSlug("日本語だけ"), "");
  assert.equal(suggestProjectSlug("", ["team/client_app"]), "client_app");
});

test("slug format matches the server-side project slug contract", () => {
  for (const slug of ["a", "web-app", "name_v2", "a.b", "a".repeat(100)]) {
    assert.equal(PROJECT_SLUG_PATTERN.test(slug), true);
    assert.equal(validateProjectSlug(slug), null);
  }
  for (const slug of ["", "-start", "_start", "Bad", "日本語", "a b", "a".repeat(101)]) {
    assert.notEqual(validateProjectSlug(slug), null);
  }
});

test("project tags trim whitespace, enforce limits, and reject duplicates", () => {
  const first = addProjectTag([], "  Next.js  ", 2);
  assert.deepEqual(first, ["Next.js"]);
  assert.strictEqual(addProjectTag(first, "next.JS", 2), first);
  assert.strictEqual(addProjectTag(first, " ", 2), first);
  const second = addProjectTag(first, "  React    Query ", 2);
  assert.deepEqual(second, ["Next.js", "React Query"]);
  assert.strictEqual(addProjectTag(second, "TypeScript", 2), second);
});
