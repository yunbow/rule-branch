import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const file = (path: string) => readFileSync(new URL("../src/" + path, import.meta.url), "utf8");

test("project page prioritizes next action, then KPIs, active jobs, connections and history", () => {
  const page = file("app/w/[workspaceId]/projects/[projectId]/page.tsx");
  const markers = [
    '<section className="projectActionCallout"',
    "<ProjectRuleSummary",
    '{featured && <section id="active-job"',
    '<div id="repositories"',
    '<div id="jobs"',
  ];
  let index = 0;
  for (const marker of markers) {
    const next = page.indexOf(marker);
    assert.ok(next > index, "missing or misplaced project section: " + marker);
    index = next;
  }
  assert.match(page, /getProjectNextActions/);
  assert.match(page, /item\.status !== "removed" && !item\.deletedAt/);
  assert.doesNotMatch(page, /projectOverviewFacts/);
});

test("repository removal uses an accessible native modal, not browser confirm", () => {
  const table = file("components/domain/RepositoryTable.tsx");
  assert.match(table, /<ActionDialog/);
  assert.match(table, /onClose=\{close\}/);
  assert.match(table, /<DialogActions/);
  assert.match(table, /連携を解除/);
  assert.match(table, /className="projectRepoCards"/);
  assert.doesNotMatch(table, /\bconfirm\(/);
});

test("responsive dashboard uses compact history and mobile cards", () => {
  const jobList = file("components/domain/JobList.tsx");
  const jobProgress = file("components/domain/JobProgress.tsx");
  const css = file("globals.css");
  assert.match(jobList, /const INITIAL_VISIBLE = 5/);
  assert.match(jobList, /showAll \? MAX_JOBS : INITIAL_VISIBLE/);
  assert.match(jobList, /projectJobMobileCards/);
  assert.match(jobProgress, /compact = false/);
  assert.match(css, /\.projectMetricGrid\{display:grid;grid-template-columns:repeat\(4/);
  assert.match(css, /@media\(max-width:1000px\)/);
  assert.match(css, /\.projectPage \.projectRepoCards/);
  assert.match(css, /\.projectPage \.projectJobMobileCards/);
});

test("status metrics keep GitHub verification distinct from AI compliance", () => {
  const summary = file("components/domain/ProjectRuleSummary.tsx");
  assert.match(summary, /反映確認済み/);
  assert.match(summary, /AIによるルール遵守を示す値ではありません/);
  assert.match(summary, /draftPrCount > 0/);
  assert.doesNotMatch(summary, /counts\.candidates \+ counts\.stale/);
});
