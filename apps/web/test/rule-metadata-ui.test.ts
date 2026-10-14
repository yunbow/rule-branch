import assert from "node:assert/strict";
import test from "node:test";
import {
  ruleMetadataChanges,
  ruleMetadataError,
  ruleMetadataFieldErrors,
  ruleMetadataScopeSummary,
  ruleMetadataValues,
} from "../src/lib/rule-metadata-form.ts";

const repositories = [
  { id: "repo-a", fullName: "example/web" },
  { id: "repo-b", fullName: "example/api" },
];

test("scope summary identifies all repositories and unrestricted optional conditions", () => {
  const values = ruleMetadataValues({ title: "Security" });
  const summary = ruleMetadataScopeSummary(values, "all", repositories);
  assert.equal(summary.find((row) => row.key === "repositoryIds")?.value, "このプロジェクトの全リポジトリ");
  assert.equal(summary.find((row) => row.key === "directoryGlobs")?.value, "制限なし（未指定）");
  assert.equal(summary.length, 5);
});

test("selected repository summary uses real names and preserves unknown IDs", () => {
  const values = ruleMetadataValues({ title: "Security", selector: { repositoryIds: ["repo-a", "old-repo"] } });
  const summary = ruleMetadataScopeSummary(values, "specific", repositories);
  assert.equal(summary.find((row) => row.key === "repositoryIds")?.value, "example/web, old-repo");
});

test("removing a scope restriction is flagged for review, without claiming actual file matches", () => {
  const initial = ruleMetadataValues({
    title: "Rule", selector: { repositoryIds: ["repo-a"], languages: ["TypeScript"], directoryGlobs: ["apps/web/**"] },
  });
  const updated = ruleMetadataValues({ title: "Rule" });
  const changes = ruleMetadataChanges(initial, updated, "specific", "all", repositories);
  const repository = changes.find((change) => change.key === "repositoryIds");
  assert.equal(repository?.before, "example/web");
  assert.equal(repository?.after, "このプロジェクトの全リポジトリ");
  assert.equal(repository?.restrictionRemoved, true);
  assert.equal(changes.find((change) => change.key === "directoryGlobs")?.restrictionRemoved, true);
  assert.equal(changes.find((change) => change.key === "languages")?.after, "制限なし（未指定）");
  assert.ok(changes.every((change) => change.scope));
});

test("adding a restriction does not raise the widening warning", () => {
  const initial = ruleMetadataValues({ title: "Rule" });
  const updated = ruleMetadataValues({
    title: "Rule", selector: { languages: ["Kotlin"], repositoryIds: ["repo-b"] },
  });
  const changes = ruleMetadataChanges(initial, updated, "all", "specific", repositories);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((change) => change.restrictionRemoved === false));
});

test("tag ordering alone does not produce a metadata change", () => {
  const initial = ruleMetadataValues({ title: "Rule", tags: ["security", "build"] });
  const updated = ruleMetadataValues({ title: "Rule", tags: ["build", "security"] });
  assert.deepEqual(ruleMetadataChanges(initial, updated, "all", "all", repositories), []);
});

test("metadata editor change preview separates scope, monitoring and assignment", () => {
  const initial = ruleMetadataValues({
    title: "Before", maintenance: { watchDependencies: ["react"] }, ownerUserId: "u1",
  });
  const updated = ruleMetadataValues({
    title: "After", maintenance: { watchDependencies: ["next"] }, ownerUserId: "u2",
  });
  const changes = ruleMetadataChanges(initial, updated, "all", "all", repositories);
  assert.deepEqual(changes.map((change) => change.key), ["title", "watchDependencies", "ownerUserId"]);
  assert.ok(changes.every((change) => change.scope === false));
});

test("per-field validation returns user-facing Japanese names, preserving legacy first error", () => {
  const values = ruleMetadataValues({
    title: "Rule",
    selector: { directoryGlobs: Array.from({ length: 51 }, (_, index) => "apps/" + index) },
    maintenance: { watchDependencies: Array(51).fill("react") },
  });
  const errors = ruleMetadataFieldErrors(values, "specific");
  assert.match(errors.repositoryIds ?? "", /リポジトリ/);
  assert.match(errors.directoryGlobs ?? "", /対象ディレクトリ/);
  assert.match(errors.watchDependencies ?? "", /変更を監視する依存関係/);
  assert.equal(ruleMetadataError(values, "specific"), errors.repositoryIds);

  const blank = ruleMetadataValues({ title: "  " });
  assert.match(ruleMetadataFieldErrors(blank, "all").title ?? "", /タイトル/);
});
