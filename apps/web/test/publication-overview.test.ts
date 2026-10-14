import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPublicationDate, getPublicationSummary, getRepositoryPublication,
  matchesPublicationFilter, normalizePublicationData, publicationAttentionRank,
  safePublicationPrUrl,
} from "../src/lib/publication-overview.ts";

const repositories = [
  { id: "a", fullName: "owner/repo-a" },
  { id: "b", fullName: "owner/repo-b" },
  { id: "c", fullName: "owner/repo-c" },
  { id: "d", fullName: "owner/repo-d" },
  { id: "e", fullName: "owner/repo-e" },
  { id: "f", fullName: "owner/repo-f" },
];

const records = normalizePublicationData([
  { id: "a-draft", repositoryId: "a", status: "draft_open", prNumber: 1,
    prUrl: "https://github.com/owner/repo-a/pull/1", openedAt: "2026-10-10T00:00:00Z" },
  { id: "a-merged", repositoryId: "a", status: "merged", prNumber: 0,
    mergedAt: "2026-10-08T00:00:00Z", verification: { state: "verified", checkedCommitSha: "xyz" } },
  { id: "b-merged", repositoryId: "b", status: "merged",
    mergedAt: "2026-10-09T00:00:00Z", verification: { state: "mismatch",
      mismatchedPaths: ["AGENTS.md", "some/rule.md"] } },
  { id: "b-draft", repositoryId: "b", status: "draft_open",
    openedAt: "2026-10-10T00:00:00Z" },
  { id: "c-merged", repositoryId: "c", status: "merged", mergedAt: "2026-10-09T12:00:00Z",
    verification: null },
  { id: "d-merged", repositoryId: "d", status: "merged", mergedAt: "2026-10-07T00:00:00Z",
    verification: { state: "verified" } },
  { id: "foreign", repositoryId: "other", status: "draft_open" },
  { id: "removed", repositoryId: "b", status: "draft_open", deletedAt: "2026-10-10" },
], [
  { id: "artifact", repositoryId: "e", target: "codex", path: "AGENTS.md",
    generatedAt: "2026-10-10T09:30:00Z", publishedAt: null,
    content: "private generated file bytes" },
  { id: "foreign-artifact", repositoryId: "other", content: "private" },
], new Set(repositories.map((r) => r.id)));

test("hydration excludes foreign, deleted and sensitive content, and preserves generation date", () => {
  assert.equal(records.revisionPrs.length, 6);
  assert.equal(records.compiledArtifacts.length, 1);
  const artifact = records.compiledArtifacts[0]!;
  assert.equal(artifact.generatedAt, "2026-10-10T09:30:00Z");
  assert.equal(artifact.publishedAt, undefined);
  assert.equal("content" in artifact, false);
  assert.equal("content" in records.revisionPrs[0]!, false);
});

test("draft PR and latest merged verification can coexist without overwriting each other", () => {
  const a = getRepositoryPublication("a", records);
  const b = getRepositoryPublication("b", records);
  assert.equal(a.latestDraft?.id, "a-draft");
  assert.equal(a.latestMerged?.id, "a-merged");
  assert.equal(a.verification, "verified");
  assert.equal(b.latestDraft?.id, "b-draft");
  assert.equal(b.verification, "mismatch");
  assert.deepEqual(b.latestMerged?.verification?.mismatchedPaths, ["AGENTS.md", "some/rule.md"]);
  assert.equal(matchesPublicationFilter(b, "draft"), true);
  assert.equal(matchesPublicationFilter(b, "mismatch"), true);
});

test("summary counts PRs and latest merged repository states separately", () => {
  assert.deepEqual(getPublicationSummary(repositories, records), {
    drafts: 2,
    draftRepositories: 2,
    pending: 1,
    mismatch: 1,
    verified: 2,
    unrecorded: 1,
  });
  assert.equal(getRepositoryPublication("c", records).hasMissingVerification, true);
  assert.equal(getRepositoryPublication("e", records).isUnrecorded, false);
  assert.equal(getRepositoryPublication("f", records).isUnrecorded, true);
});

test("attention ordering prioritizes mismatches, draft PRs, pending and missing records", () => {
  const items = repositories.map((repo) => ({
    name: repo.fullName,
    rank: publicationAttentionRank(getRepositoryPublication(repo.id, records)),
  })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  assert.deepEqual(items.map((item) => item.name),
    ["owner/repo-b", "owner/repo-a", "owner/repo-c",
      "owner/repo-f", "owner/repo-e", "owner/repo-d"]);
});

test("invalid or cross-repository PR destinations are rejected", () => {
  assert.equal(safePublicationPrUrl("https://github.com/owner/repo-a/pull/123", "owner/repo-a"),
    "https://github.com/owner/repo-a/pull/123");
  for (const unsafe of [
    "javascript:alert(1)", "https://github.com.evil.test/owner/repo-a/pull/123",
    "https://github.com/owner/repo-b/pull/123",
    "https://github.com/owner/repo-a/issues/123",
    "https://github.com/owner/repo-a/pull/not-a-number",
    "https://github.com/owner/repo-a/pull/123/commits",
    "https://user@github.com/owner/repo-a/pull/123",
    "http://github.com/owner/repo-a/pull/123",
  ]) assert.equal(safePublicationPrUrl(unsafe, "owner/repo-a"), null, unsafe);
});

test("date formatting is explicitly JST and missing generation times are not fabricated", () => {
  assert.match(formatPublicationDate("2026-10-10T09:30:00Z", true), /18:30/);
  assert.equal(formatPublicationDate(undefined, true), "—");
  assert.equal(formatPublicationDate("invalid"), "—");
});
