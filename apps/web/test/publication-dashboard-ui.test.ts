import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL("../src/" + path, import.meta.url), "utf8");

test("project publications excludes unlinked repositories and hydrates only filtered records", () => {
  const page = src("app/w/[workspaceId]/projects/[projectId]/publications/page.tsx");
  assert.match(page, /repository\.status === "active" && !repository\.deletedAt/);
  assert.match(page, /normalizePublicationData\(revisionPrs, compiledArtifacts, activeRepositoryIds\)/);
  assert.match(page, /<PublicationDashboard/);
  assert.doesNotMatch(page, /repositories\.map\(\(repository\) =>\s*<RepositoryPublicationCard/);
});

test("one dashboard fetch replaces per-card requests and stale data survives refresh errors", () => {
  const dashboard = src("components/domain/PublicationDashboard.tsx");
  const card = src("components/domain/RepositoryPublicationCard.tsx");
  assert.match(dashboard, /apiFetch<\{ revisionPrs:/);
  assert.match(dashboard, /apiFetch<\{ compiledArtifacts:/);
  assert.match(dashboard, /前回取得した表示を維持しています/);
  assert.match(dashboard, /matchesPublicationFilter/);
  assert.match(dashboard, /publicationAttentionRank/);
  assert.doesNotMatch(card, /apiFetch\(/);
});

test("cards separate Draft PR and latest merged verification, expose findings and compact artifacts", () => {
  const card = src("components/domain/RepositoryPublicationCard.tsx");
  assert.match(card, /publicationPrimaryGrid/);
  assert.match(card, /latestDraft/);
  assert.match(card, /latestMerged/);
  assert.match(card, /isAggregateArtifactPath\(path\)/);
  assert.match(card, /drift\?type=artifact_mismatch&path=/);
  assert.match(card, /const INITIAL_ARTIFACT_LIMIT = 5/);
  assert.match(card, /formatPublicationDate\(artifact\.generatedAt, true\)/);
  assert.doesNotMatch(card, /formatPublicationDate\(artifact\.publishedAt/);
  assert.match(card, /publicationMaintenance/);
  assert.match(card, /safePublicationPrUrl/);
});

test("recompile confirmation protects existing Draft PRs", () => {
  const component = src("components/domain/RecompileButton.tsx");
  assert.match(component, /<ActionDialog/);
  assert.match(component, /open=\{confirming\}/);
  assert.match(component, /<DialogActions/);
  assert.match(component, /hasDraftPr &&/);
  assert.match(component, /マージは自動実行しません/);
  assert.match(component, /canRecompile\(kind, role\)/);
});

test("mobile card layouts, refresh, and accessible status filters are present", () => {
  const dashboard = src("components/domain/PublicationDashboard.tsx");
  const css = src("globals.css");
  assert.match(dashboard, /aria-pressed=\{filter === metric\.value\}/);
  assert.match(dashboard, /取得：\{formatPublicationDate\(lastFetchedAt, true\)\}/);
  assert.match(dashboard, /setRequestedTarget/);
  assert.match(css, /\.publicationSummary\{display:grid/);
  assert.match(css, /@media\(max-width:950px\)/);
  assert.match(css, /@media\(max-width:660px\)/);
  assert.match(css, /\.publicationArtifactEntry\{display:grid/);
});
