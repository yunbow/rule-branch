import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL("../src/" + path, import.meta.url), "utf8");

test("history page shows a project-level browser without extra nested sections", () => {
  const page = src("app/w/[workspaceId]/projects/[projectId]/decisions/page.tsx");
  assert.match(page, /className="pageContainer decisionPage"/);
  assert.match(page, /<DecisionMemoryList workspaceId=/);
  assert.doesNotMatch(page, /<PageSection title="記録一覧"/);
});

test("browser supports period, sorting, grouped view, and progressive paging", () => {
  const list = src("components/domain/DecisionMemoryList.tsx");
  assert.match(list, /countDecisionMemories/);
  assert.match(list, /groupDecisionMemories/);
  assert.match(list, /filterAndSortDecisionMemories/);
  assert.match(list, /DECISION_PAGE_SIZE/);
  assert.match(list, /"90"/);
  assert.match(list, /"oldest"/);
  assert.match(list, /"rule"/);
  assert.match(list, /role="group" aria-label="判断記録の表示方法"/);
  assert.match(list, /setVisibleLimit\(\(current\) => current \+ DECISION_PAGE_SIZE\)/);
});

test("record cards separate decision reasons, approval details and linked version", () => {
  const card = src("components/domain/DecisionMemoryCard.tsx");
  assert.match(card, /判断理由/);
  assert.match(card, /承認内容・コメント/);
  assert.match(card, /approvedRuleVersionId/);
  assert.match(card, /approvedVersionHref/);
  assert.match(card, /approvalMode === "automatic"/);
  assert.match(card, /過去の関連ルール（現在は確認不可）/);
  assert.match(card, /<DecisionPublicationStatus/);
  assert.doesNotMatch(card, /<dt>影響<\/dt>/);
});

test("exact approved-version publication lookup is lazy and does not imply AI compliance", () => {
  const status = src("components/domain/DecisionPublicationStatus.tsx");
  const card = src("components/domain/DecisionMemoryCard.tsx");
  assert.match(status, /apiFetch<PublicationState>/);
  assert.match(status, /AIによるルール遵守/);
  assert.match(status, /承認当時の状態/);
  assert.match(card, /approvedVersion && approvedVersionHref/);
  assert.doesNotMatch(status, /useEffect.*\[\]/s);
});

test("new manual and automatic approvals record version ID in the same transaction", () => {
  const manual = src("shared/rulestore.ts");
  const automatic = src("shared/firestore-approval-repository.ts");
  assert.match(manual, /approvedRuleVersionId: ruleVersionId/);
  assert.match(manual, /approvalMode: "human"/);
  assert.match(automatic, /approvedRuleVersionId: pointer.versionId/);
  assert.match(automatic, /approvalMode: "automatic"/);
});

test("decision cards have responsive styles and explicit keyboard focus", () => {
  const css = src("globals.css");
  assert.match(css, /\.decisionMemoryStats\{display:grid/);
  assert.match(css, /\.decisionMemoryFilters\{display:grid/);
  assert.match(css, /\.decisionRecordCard/);
  assert.match(css, /@media\(max-width:680px\)/);
  assert.match(css, /\.decisionRecordDetails>summary:focus-visible/);
});
