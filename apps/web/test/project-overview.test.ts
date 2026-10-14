import assert from "node:assert/strict";
import test from "node:test";
import { getProjectNextActions } from "../src/lib/project-overview.ts";

const basePath = "/w/workspace/projects/project";
const counts = { candidates: 0, stale: 0, unpublished: 0, published: 0 };
const base = {
  basePath,
  repositoryCount: 2,
  activeRepositoryCount: 2,
  canManageRepositories: true,
  activeJobCount: 0,
  jobCount: 1,
  latestJobFailed: false,
  counts,
};

test("no repositories provides a single setup action", () => {
  const result = getProjectNextActions({ ...base, repositoryCount: 0, activeRepositoryCount: 0 });
  assert.equal(result.primary.id, "repositories");
  assert.equal(result.primary.label, "リポジトリを追加");
  assert.equal(result.secondary, undefined);
});

test("viewers are not instructed to perform unavailable admin actions", () => {
  const result = getProjectNextActions({
    ...base, canManageRepositories: false, repositoryCount: 0, activeRepositoryCount: 0,
  });
  assert.equal(result.primary.label, "接続状況を確認");
  assert.match(result.primary.description, /管理者/);
});

test("inactive repositories are not treated as available for analysis", () => {
  const result = getProjectNextActions({ ...base, activeRepositoryCount: 0 });
  assert.equal(result.primary.label, "リポジトリを確認");
});

test("running analysis does not hide rule candidates or a secondary task", () => {
  const result = getProjectNextActions({
    ...base,
    activeJobCount: 1,
    counts: { ...counts, candidates: 3, unpublished: 2 },
  });
  assert.equal(result.primary.id, "candidates");
  assert.match(result.primary.description, /3件/);
  assert.equal(result.secondary?.id, "unpublished");
});

test("recent failure takes priority and preserves other review work", () => {
  const result = getProjectNextActions({
    ...base,
    latestJobFailed: true,
    counts: { ...counts, stale: 5 },
  });
  assert.equal(result.primary.id, "failed");
  assert.equal(result.secondary?.id, "stale");
});

test("only a running job or a default link when there is no pending review", () => {
  assert.equal(getProjectNextActions({ ...base, activeJobCount: 1 }).primary.id, "running");
  assert.equal(getProjectNextActions(base).primary.id, "rules");
});

test("registered repository without any analysis job gives a setup check", () => {
  assert.equal(getProjectNextActions({ ...base, jobCount: 0 }).primary.id, "awaiting-analysis");
});

test("published count alone does not falsely imply an open task", () => {
  assert.equal(getProjectNextActions({
    ...base, counts: { ...counts, published: 20 },
  }).primary.id, "rules");
});
