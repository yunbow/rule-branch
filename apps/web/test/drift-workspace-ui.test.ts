import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relative: string) => readFileSync(new URL("../src/" + relative, import.meta.url), "utf8");

test("stale rule expansion uses a standalone card rather than mismatched table columns", () => {
  const stale = source("components/domain/StaleRuleRow.tsx");
  const view = source("components/domain/DriftListClient.tsx");
  assert.match(stale, /className="driftRuleCard"/);
  assert.match(stale, /className="driftRuleCardDetails"/);
  assert.match(stale, /aria-expanded=\{expanded\}/);
  assert.doesNotMatch(stale, /<tr\b|<td\b|<th\b/);
  assert.doesNotMatch(view, /<Table\b|<thead\b|<tbody\b/);
});

test("triage action preserves permissions and only closes dismiss after success", () => {
  const view = source("components/domain/FindingRow.tsx");
  assert.match(view, /canTriage\(workspaceKind, role\)/);
  assert.match(view, /対応対象に追加/);
  assert.match(view, /修正は完了しません/);
  assert.match(view, /await action\("dismiss", reason\)/);
  assert.match(view, /if \(await action\("dismiss", reason\)\)/);
  assert.match(view, /role="alert"/);
  assert.doesNotMatch(view, /setDismissOpen\(false\);\s*void action/);
});

test("the page retains verified publication deep links and backfills repository from trigger", () => {
  const page = source("app/w/[workspaceId]/projects/[projectId]/drift/page.tsx");
  const view = source("components/domain/DriftListClient.tsx");
  assert.match(page, /query\.type === "artifact_mismatch"/);
  assert.match(page, /repositoryByTrigger\.get\(finding\.triggerId\)/);
  assert.match(page, /"change_triggers", \{ projectId \}/);
  assert.match(page, /getProjectJobs\(workspaceId, userId, projectId\)/);
  assert.match(page, /initialJobs=\{projectJobs\.filter/);
  assert.match(view, /filterFindings\(findings, statuses, type, path\)/);
  assert.match(view, /matchesFindingPath\(finding, path\)/);
  assert.match(view, /initialStatus === "none"/);
  assert.match(view, /window\.history\.replaceState/);
});

test("responsive filters, prioritized cards, and compact scan status are present", () => {
  const view = source("components/domain/DriftListClient.tsx");
  const finding = source("components/domain/FindingRow.tsx");
  const css = source("globals.css");
  assert.match(view, /presentDriftFindings/);
  assert.match(view, /ずれを再スキャン/);
  assert.match(view, /compact onDone=\{onJobDone\}/);
  assert.match(view, /条件をクリア/);
  assert.match(view, /role="group" aria-label="指摘の状態で絞り込み"/);
  assert.match(finding, /driftFindingEvidence/);
  assert.match(css, /@media\(max-width:680px\)/);
  assert.match(css, /\.driftFindingActions/);
});
