import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const ctx = { workspaceId: "workspace", actorUserId: "viewer" };

function fixture() {
  const db = new InMemoryFirestore();
  const store = new FirestoreRuleStore(db);
  db.put("projects/active", { id: "active", ownerWorkspaceId: ctx.workspaceId, status: "active", deletedAt: null });
  db.put("projects/deleted", { id: "deleted", ownerWorkspaceId: ctx.workspaceId, status: "archived", deletedAt: "2026-10-13T00:00:00.000Z" });
  for (const projectId of ["active", "deleted", "missing"]) {
    db.put(`repositories/repository-${projectId}`, { id: `repository-${projectId}`, ownerWorkspaceId: ctx.workspaceId, projectId, status: "active", deletedAt: null });
    db.put(`analysis_jobs/job-${projectId}`, { id: `job-${projectId}`, ownerWorkspaceId: ctx.workspaceId, projectId, type: "bootstrap", status: "done", deletedAt: null });
    db.put(`rules/rule-${projectId}`, { id: `rule-${projectId}`, ownerWorkspaceId: ctx.workspaceId, projectId, scopeType: "project", scopeId: projectId, status: "active", deletedAt: null });
    db.put(`rule_versions/version-${projectId}`, { id: `version-${projectId}`, ownerWorkspaceId: ctx.workspaceId, ruleId: `rule-${projectId}`, status: "approved", deletedAt: null });
    db.put(`rule_checks/check-${projectId}`, { id: `check-${projectId}`, ownerWorkspaceId: ctx.workspaceId, ruleId: `rule-${projectId}`, deletedAt: null });
    db.put(`evidence/evidence-${projectId}`, { id: `evidence-${projectId}`, ownerWorkspaceId: ctx.workspaceId, ruleVersionId: `version-${projectId}`, deletedAt: null });
  }
  db.put("rules/organization-rule", { id: "organization-rule", ownerWorkspaceId: ctx.workspaceId, projectId: null, scopeType: "organization", scopeId: ctx.workspaceId, status: "active", deletedAt: null });
  db.put("rule_versions/organization-version", { id: "organization-version", ownerWorkspaceId: ctx.workspaceId, ruleId: "organization-rule", status: "approved", deletedAt: null });
  db.put("rule_checks/organization-check", { id: "organization-check", ownerWorkspaceId: ctx.workspaceId, ruleId: "organization-rule", deletedAt: null });
  db.put("rule_checks/orphan-check", { id: "orphan-check", ownerWorkspaceId: ctx.workspaceId, ruleId: "missing-rule", deletedAt: null });
  db.put("rule_checks/foreign-parent-check", { id: "foreign-parent-check", ownerWorkspaceId: ctx.workspaceId, ruleId: "foreign-rule", deletedAt: null });
  db.put("rules/foreign-rule", { id: "foreign-rule", ownerWorkspaceId: "other", status: "active", scopeType: "organization", scopeId: "other" });
  db.put("evidence/organization-evidence", { id: "organization-evidence", ownerWorkspaceId: ctx.workspaceId, scopeType: "organization", scopeId: ctx.workspaceId, deletedAt: null });
  db.put("repositories/legacy-active", { id: "legacy-active", ownerWorkspaceId: ctx.workspaceId, projectId: "active", status: "active", deletedAt: null });
  db.put("repositories/legacy-deleted", { id: "legacy-deleted", ownerWorkspaceId: ctx.workspaceId, projectId: "deleted", status: "removed", deletedAt: "2026-10-13T00:00:00.000Z" });
  for (const [id, repositoryId] of [["active", "legacy-active"], ["deleted", "legacy-deleted"], ["missing", "legacy-missing"]]) {
    db.put(`revision_prs/legacy-pr-${id}`, { id: `legacy-pr-${id}`, ownerWorkspaceId: ctx.workspaceId, repositoryId, status: "merged", deletedAt: null });
    db.put(`compiled_artifacts/legacy-artifact-${id}`, { id: `legacy-artifact-${id}`, ownerWorkspaceId: ctx.workspaceId, repositoryId, deletedAt: null });
  }
  return { db, store };
}

test("tenant reads hide direct children of deleted or missing projects", async () => {
  const { store } = fixture();
  assert.equal((await store.get(ctx, "repositories", "repository-active"))?.id, "repository-active");
  assert.equal(await store.get(ctx, "repositories", "repository-deleted"), null);
  assert.equal(await store.get(ctx, "repositories", "repository-missing"), null);
  assert.deepEqual((await store.list(ctx, "analysis_jobs")).map((item) => item.id), ["job-active"]);
  assert.deepEqual((await store.getMany(ctx, "repositories", ["repository-active", "repository-deleted", "repository-missing"])).map((item) => item.id), ["repository-active"]);
  assert.deepEqual((await store.listQuery(ctx, "repositories", [], { limit: 10 })).map((item) => item.id).sort(), ["legacy-active", "repository-active"]);
});

test("tenant reads follow rule-version parents while retaining organization records", async () => {
  const { store } = fixture();
  assert.equal((await store.get(ctx, "rule_versions", "version-active"))?.id, "version-active");
  assert.equal(await store.get(ctx, "rule_versions", "version-deleted"), null);
  assert.equal(await store.get(ctx, "rule_versions", "version-missing"), null);
  assert.equal((await store.get(ctx, "evidence", "evidence-active"))?.id, "evidence-active");
  assert.equal(await store.get(ctx, "evidence", "evidence-deleted"), null);
  assert.equal(await store.get(ctx, "evidence", "evidence-missing"), null);
  assert.equal((await store.get(ctx, "evidence", "organization-evidence"))?.id, "organization-evidence");
  assert.equal((await store.get(ctx, "revision_prs", "legacy-pr-active"))?.id, "legacy-pr-active");
  assert.equal(await store.get(ctx, "revision_prs", "legacy-pr-deleted"), null);
  assert.equal(await store.get(ctx, "revision_prs", "legacy-pr-missing"), null);
  assert.equal((await store.get(ctx, "compiled_artifacts", "legacy-artifact-active"))?.id, "legacy-artifact-active");
  assert.equal(await store.get(ctx, "compiled_artifacts", "legacy-artifact-deleted"), null);
  assert.equal(await store.get(ctx, "compiled_artifacts", "legacy-artifact-missing"), null);
  assert.deepEqual(
    (await store.list(ctx, "rule_versions")).map((item) => item.id).sort(),
    ["organization-version", "version-active"],
  );
});

test("rule checks resolve their ruleId parent and remain tenant/project scoped in all read paths", async () => {
  const { store } = fixture();
  assert.equal((await store.get(ctx, "rule_checks", "check-active"))?.id, "check-active");
  for (const id of ["check-deleted", "check-missing", "orphan-check", "foreign-parent-check"]) {
    assert.equal(await store.get(ctx, "rule_checks", id), null, id);
  }
  assert.deepEqual(
    (await store.list(ctx, "rule_checks")).map((check) => check.id).sort(),
    ["check-active", "organization-check"],
  );
  assert.deepEqual(
    (await store.getMany(ctx, "rule_checks", ["check-active", "check-deleted", "organization-check"])).map((check) => check.id).sort(),
    ["check-active", "organization-check"],
  );
  assert.deepEqual(
    (await store.listQuery(ctx, "rule_checks", [], { limit: 20 })).map((check) => check.id).sort(),
    ["check-active", "organization-check"],
  );
});
