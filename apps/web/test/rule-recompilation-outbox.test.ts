import assert from "node:assert/strict";
import test from "node:test";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, type DocumentData } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  const workspaceId = "workspace-recompile", userId = "owner-recompile";
  db.put(`workspaces/${workspaceId}`, { id: workspaceId, status: "active", kind: "organization" });
  db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, {
    id: `workspace_member:${workspaceId}:${userId}`, ownerWorkspaceId: workspaceId, targetId: "owner-membership",
  });
  db.put("workspace_members/owner-membership", { id: "owner-membership", ownerWorkspaceId: workspaceId, workspaceId, userId, role: "owner" });
  for (const id of ["project-a", "project-b"]) db.put(`projects/${id}`, {
    id, ownerWorkspaceId: workspaceId, status: "active", deletedAt: null,
  });
  for (const [id, projectId, status] of [
    ["repo-a", "project-a", "active"], ["repo-b", "project-a", "active"],
    ["repo-c", "project-b", "active"], ["repo-unlinked", "project-a", "removed"],
  ]) db.put(`repositories/${id}`, { id, ownerWorkspaceId: workspaceId, projectId, status, deletedAt: null });
  db.put("rules/project-rule", {
    id: "project-rule", ownerWorkspaceId: workspaceId, projectId: "project-a",
    scopeType: "project", scopeId: "project-a", layer: "L3", type: "guideline",
    enforcement: "default", evaluationMode: "semantic", currentVersionId: "approved-v1",
    status: "active", selector: { repositoryIds: ["repo-a"] },
    maintenance: { reviewIntervalDays: 30, watchDependencies: [] },
  });
  db.put("rules/organization-rule", {
    id: "organization-rule", ownerWorkspaceId: workspaceId, projectId: null,
    scopeType: "organization", scopeId: workspaceId,
    enforcement: "default", currentVersionId: "organization-v1", status: "active",
  });
  return { db, store, service: new RulesService(store), workspaceId, userId };
}
function jobRepos(db: InMemoryFirestore) {
  return db.query("analysis_jobs", []).map((snapshot) => (snapshot.data()!.payload as DocumentData).repositoryId).sort();
}

test("selector mutation recompiles both formerly selected and newly selected repositories", async () => {
  const f = fixture();
  const updated = await f.service.updateRuleMetadata(f.workspaceId, f.userId, "project-rule", {
    selector: { repositoryIds: ["repo-b"] },
  });
  assert.deepEqual((updated.selector as DocumentData).repositoryIds, ["repo-b"]);
  assert.deepEqual(jobRepos(f.db), ["repo-a", "repo-b"]);
  const stored = f.db.snapshot("rules", "project-rule").data()!;
  assert.equal(stored.compilePending, false);
  assert.deepEqual(stored.pendingCompileRepositoryIds, []);
  assert.equal(await f.store.reconcilePendingCompilations(), 0);
  assert.deepEqual(jobRepos(f.db), ["repo-a", "repo-b"]);
});

test("a failed Cloud Tasks dispatch leaves durable intent for scheduler reconciliation", async () => {
  const f = fixture(), original = f.store.createAnalysisJob.bind(f.store);
  let fail = true;
  f.store.createAnalysisJob = async (ctx, input) => {
    if (fail) throw new Error("temporary dispatch failure");
    return original(ctx, input);
  };
  await f.service.updateRuleMetadata(f.workspaceId, f.userId, "project-rule", {
    selector: { repositoryIds: ["repo-b"] },
  });
  assert.equal(f.db.snapshot("rules", "project-rule").data()!.compilePending, true);
  assert.deepEqual(jobRepos(f.db), []);
  fail = false;
  assert.equal(await f.store.reconcilePendingCompilations(), 1);
  assert.deepEqual(jobRepos(f.db), ["repo-a", "repo-b"]);
  assert.equal(f.db.snapshot("rules", "project-rule").data()!.compilePending, false);
  assert.equal(await f.store.reconcilePendingCompilations(), 0);
  assert.deepEqual(jobRepos(f.db), ["repo-a", "repo-b"]);
});

test("deprecating a rule queues compilation of its former recipients", async () => {
  const f = fixture();
  const updated = await f.service.updateRuleStatus(f.workspaceId, f.userId, "project-rule", "deprecated", { rationale: "replaced" });
  assert.equal(updated.status, "deprecated");
  assert.deepEqual(jobRepos(f.db), ["repo-a"]);
});

test("creating a deny relation recompiles the affected project only", async () => {
  const f = fixture();
  const relation = await f.service.createRelation(f.workspaceId, f.userId, {
    parentRuleId: "organization-rule", childRuleId: "project-rule",
    relationType: "deny", rationale: "Project exemption",
  });
  assert.equal(relation.relationType, "deny");
  assert.deepEqual(jobRepos(f.db), ["repo-a"]);
});
