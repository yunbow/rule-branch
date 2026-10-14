import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAndSortProjects, hasNoProjectActions, isProjectSetupPending, needsProjectAction,
} from "../src/lib/project-catalog.ts";
import type { BootstrapStatus, WorkspaceProjectSummary } from "../src/lib/workspace-overview.ts";

const project = (id: string, overrides: Partial<WorkspaceProjectSummary> = {}): WorkspaceProjectSummary => ({
  id, name: id, slug: id, description: "", createdAt: "",
  repositoryCount: 1, activeRuleCount: 0,
  humanReviewCount: 0, evaluatingCount: 0, unreviewedCount: 0,
  openDriftCount: 0, candidateCount: 0, unpublishedCount: 0, publishedCount: 0,
  publicationAvailable: true, ...overrides,
});

test("search matches name, slug and description, including Japanese", () => {
  const projects = [
    project("one", { name: "Web API", slug: "backend-api", description: "社内認証サーバー" }),
    project("two", { name: "Mobile App", slug: "ios-app", description: "iOS frontend" }),
  ];
  const states: Record<string, BootstrapStatus> = { one: "done", two: "done" };
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, search: "api" }).map((p) => p.id), ["one"]);
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, search: "  社内認証  " }).map((p) => p.id), ["one"]);
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, search: "iOS" }).map((p) => p.id), ["two"]);
  assert.equal(filterAndSortProjects({ projects, bootstrapStatusByProject: states, search: "absent" }).length, 0);
});

test("action filter treats human review, open drift, unpublished and bootstrap failure as needs", () => {
  const reviewed = project("review", { humanReviewCount: 2 });
  const drift = project("drift", { openDriftCount: 1 });
  const unpublished = project("publication", { unpublishedCount: 3 });
  const pending = project("setup", { repositoryCount: 0 });
  const failed = project("failed");
  const healthy = project("healthy");
  const projects = [healthy, pending, failed, unpublished, drift, reviewed];
  const states: Record<string, BootstrapStatus> = {
    healthy: "done", failed: "failed", unpublished: "done", drift: "done", reviewed: "done",
  };
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, filter: "action" }).map((p) => p.id),
    ["review", "drift", "publication", "failed"]);
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, filter: "setup" }).map((p) => p.id),
    ["failed", "setup"]);
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, filter: "clear" }).map((p) => p.id),
    ["healthy"]);
  assert.equal(needsProjectAction(reviewed, "done"), true);
  assert.equal(isProjectSetupPending(pending), true);
});

test("a missing bootstrap or publication state is not considered all clear", () => {
  const unknownPublication = project("p1", { publicationAvailable: false });
  const known = project("p2");
  assert.equal(hasNoProjectActions(unknownPublication, "done"), false);
  assert.equal(hasNoProjectActions(known), false);
  assert.equal(hasNoProjectActions(known, "running"), false);
  assert.equal(hasNoProjectActions(known, "done"), true);
});

test("sorting can use names or creation dates and keeps stable order for ties", () => {
  const projects = [
    project("older", { name: "Zulu", createdAt: "2026-01-01T00:00:00Z" }),
    project("newer", { name: "Alpha", createdAt: "2026-10-01T00:00:00Z" }),
    project("other", { name: "Alpha", createdAt: "" }),
  ];
  const states: Record<string, BootstrapStatus> = { older: "done", newer: "done", other: "done" };
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, sort: "newest" }).map((p) => p.id), ["newer", "older", "other"]);
  assert.deepEqual(filterAndSortProjects({ projects, bootstrapStatusByProject: states, sort: "name" }).map((p) => p.id), ["newer", "other", "older"]);
});
