import test from "node:test";
import assert from "node:assert/strict";
import {
  getBootstrapStatus,
  getReviewState,
  sortWorkspaceProjects,
  summarizeWorkspace,
} from "../src/lib/workspace-overview.ts";

test("review and bootstrap status labels match the real review queue", () => {
  assert.equal(getReviewState({ approvalReview: { state: "human_required" } }), "human_required");
  assert.equal(getReviewState({ approvalReview: { state: "evaluating" } }), "evaluating");
  assert.equal(getReviewState({ approvalReview: { state: "unexpected" } }), "unreviewed");
  assert.equal(getReviewState({}), "unreviewed");

  assert.equal(getBootstrapStatus(), "not_started");
  assert.equal(getBootstrapStatus({ status: "queued" }), "running");
  assert.equal(getBootstrapStatus({ status: "running" }), "running");
  assert.equal(getBootstrapStatus({ status: "done" }), "done");
  assert.equal(getBootstrapStatus({ status: "failed" }), "failed");
  assert.equal(getBootstrapStatus({ status: "dead" }), "failed");
});

test("Workspace KPI agrees with project-level publication rules and scope", () => {
  const projects = [
    { id: "p1", name: "Alpha", slug: "alpha" },
    { id: "p2", name: "Beta", slug: "beta" },
  ];
  const repositories = [
    { id: "r1", projectId: "p1", status: "active" },
    { id: "r2", projectId: "p2", status: "active" },
    { id: "r3", projectId: "p1", status: "disconnected" },
  ];
  const rules = [
    { id: "a1", projectId: "p1", status: "active", currentVersionId: "v1" },
    { id: "a2", projectId: "p1", status: "active", currentVersionId: "v2" },
    { id: "b1", projectId: "p2", status: "draft" },
    { id: "b2", projectId: "p2", status: "stale", currentVersionId: "v4" },
    { id: "personal", projectId: "p2", status: "active", currentVersionId: "v3", enforcement: "personal" },
    { id: "shared", status: "active" },
    { id: "deleted", projectId: "p1", status: "active", deletedAt: "2026-10-08" },
    { id: "old", projectId: "p1", status: "archived", currentVersionId: "v5" },
  ];
  const reviews = [
    { ruleId: "a1", approvalReview: { state: "human_required" } },
    { ruleId: "a2", approvalReview: { state: "evaluating" } },
    { ruleId: "b1" },
    { ruleId: "shared", approvalReview: { state: "human_required" } },
    { ruleId: "missing", approvalReview: { state: "unreviewed" } },
  ];
  const findings = [
    { id: "d1", status: "open", scopeId: "p1" },
    { id: "d2", status: "open", ruleId: "b2" },
    { id: "d3", status: "open", scopeId: "unknown" },
    { id: "d4", status: "accepted", projectId: "p1" },
  ];
  const publicationStates = {
    v1: { perRepository: [{ repositoryId: "r1", state: "published" }] },
    v2: { perRepository: [{ repositoryId: "r1", state: "pr_open" }] },
    v3: { perRepository: [{ repositoryId: "r2", state: "published" }] },
    v4: { perRepository: [{ repositoryId: "r2", state: "published" }] },
  };

  const overview = summarizeWorkspace({ projects, repositories, rules, reviews, findings, publicationStates });
  assert.deepEqual({
    activeRuleCount: overview.activeRuleCount,
    humanReviewCount: overview.humanReviewCount,
    evaluatingCount: overview.evaluatingCount,
    unreviewedCount: overview.unreviewedCount,
    openDriftCount: overview.openDriftCount,
    unmatchedDriftCount: overview.unmatchedDriftCount,
    unpublishedCount: overview.unpublishedCount,
    publishedCount: overview.publishedCount,
  }, {
    activeRuleCount: 4,
    humanReviewCount: 2, evaluatingCount: 1, unreviewedCount: 1,
    openDriftCount: 3, unmatchedDriftCount: 1, unpublishedCount: 1, publishedCount: 2,
  });

  const alpha = overview.projects[0], beta = overview.projects[1];
  assert.deepEqual({
    repositoryCount: alpha.repositoryCount, activeRuleCount: alpha.activeRuleCount,
    humanReviewCount: alpha.humanReviewCount, evaluatingCount: alpha.evaluatingCount,
    openDriftCount: alpha.openDriftCount,
    unpublishedCount: alpha.unpublishedCount, publishedCount: alpha.publishedCount,
  }, {
    repositoryCount: 1, activeRuleCount: 2, humanReviewCount: 1, evaluatingCount: 1,
    openDriftCount: 1, unpublishedCount: 1, publishedCount: 1,
  });
  assert.deepEqual({
    repositoryCount: beta.repositoryCount, candidateCount: beta.candidateCount,
    unreviewedCount: beta.unreviewedCount, openDriftCount: beta.openDriftCount,
    unpublishedCount: beta.unpublishedCount, publishedCount: beta.publishedCount,
  }, {
    repositoryCount: 1, candidateCount: 1, unreviewedCount: 1,
    openDriftCount: 1, unpublishedCount: 0, publishedCount: 1,
  });
});

test("project list does not label publications when publication data was not loaded", () => {
  const overview = summarizeWorkspace({
    projects: [{ id: "p1", name: "Alpha", slug: "alpha" }],
    repositories: [{ id: "r1", projectId: "p1", status: "active" }],
    rules: [{ id: "r", projectId: "p1", status: "active", currentVersionId: "v1" }],
    reviews: [], findings: [],
  });
  assert.equal(overview.projects[0].publicationAvailable, false);
  assert.equal(overview.projects[0].unpublishedCount, 0);
  assert.equal(overview.projects[0].publishedCount, 0);
  assert.equal(sortWorkspaceProjects(overview.projects)[0].name, "Alpha");
});

test("projects requiring action precede projects without urgent changes", () => {
  const overview = summarizeWorkspace({
    projects: [
      { id: "quiet", name: "Quiet", slug: "quiet" },
      { id: "drift", name: "Drift", slug: "drift" },
      { id: "review", name: "Review", slug: "review" },
    ],
    repositories: [], rules: [{ id: "rule", projectId: "review", status: "active" }],
    reviews: [{ ruleId: "rule", approvalReview: { state: "human_required" } }],
    findings: [{ status: "open", projectId: "drift" }],
  });
  assert.deepEqual(sortWorkspaceProjects(overview.projects).map((project) => project.id), [
    "review", "drift", "quiet",
  ]);
});
