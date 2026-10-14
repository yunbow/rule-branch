import assert from "node:assert/strict";
import test from "node:test";
import { listProjectJobs } from "../src/shared/analysis-jobs.ts";
import { DriftService } from "../src/shared/drift.ts";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const workspaceId = "bounded-workspace", userId = "bounded-user";
const createdAt = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  db.put(`workspaces/${workspaceId}`, { id: workspaceId, status: "active" });
  db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, { id: `workspace_member:${workspaceId}:${userId}`, ownerWorkspaceId: workspaceId, targetId: "member" });
  db.put("workspace_members/member", { id: "member", ownerWorkspaceId: workspaceId, role: "owner" });
  for (const id of ["project", "other"]) db.put(`projects/${id}`, { id, ownerWorkspaceId: workspaceId, status: "active", deletedAt: null });
  return { db, store };
}

test("project jobs apply filters, descending order, cursor, and the 50 item cap in Firestore", async () => {
  const { db, store } = fixture(), ctx = { workspaceId, actorUserId: userId };
  for (let index = 0; index < 120; index += 1) db.put(`analysis_jobs/job-${index}`, {
    id: `job-${index}`, ownerWorkspaceId: workspaceId, projectId: "project", type: index % 2 ? "compile" : "drift_scan",
    status: index < 60 ? "done" : "queued", attempts: 0, idempotencyKey: `job:${index}`, createdAt: createdAt(index),
  });
  db.put("analysis_jobs/other-project", { id: "other-project", ownerWorkspaceId: workspaceId, projectId: "other", type: "compile", status: "queued", createdAt: createdAt(999) });
  db.put("analysis_jobs/other-workspace", { id: "other-workspace", ownerWorkspaceId: "other", projectId: "project", type: "compile", status: "queued", createdAt: createdAt(999) });

  const latest = await listProjectJobs(store, ctx, "project");
  assert.equal(latest.length, 50);
  assert.deepEqual(latest.slice(0, 2).map((job) => job.id), ["job-119", "job-118"]);
  const filtered = await listProjectJobs(store, ctx, "project", { type: "compile", status: "queued" });
  assert.equal(filtered.length, 30);
  assert.ok(filtered.every((job) => job.type === "compile" && job.status === "queued"));
  const next = await listProjectJobs(store, ctx, "project", { limit: 10, startAfter: String(latest[49]!.createdAt) });
  assert.deepEqual(next.slice(0, 2).map((job) => job.id), ["job-69", "job-68"]);
});

test("rule detail queries only the rule's active findings and linked memories", async () => {
  const { db, store } = fixture(), drift = new DriftService(store), rules = new RulesService(store);
  for (const [id, ruleId, status] of [["open", "target", "open"], ["accepted", "target", "accepted"], ["resolved", "target", "resolved"], ["other", "other", "open"]] as const) {
    db.put(`drift_findings/${id}`, { id, ownerWorkspaceId: workspaceId, ruleId, status });
  }
  db.put("decision_memories/new", { id: "new", ownerWorkspaceId: workspaceId, projectId: "project", linkedRuleIds: ["target", "other"], createdAt: createdAt(2) });
  db.put("decision_memories/old", { id: "old", ownerWorkspaceId: workspaceId, projectId: "project", linkedRuleIds: ["target"], createdAt: createdAt(1) });
  db.put("decision_memories/unrelated", { id: "unrelated", ownerWorkspaceId: workspaceId, projectId: "project", linkedRuleIds: ["other"], createdAt: createdAt(3) });
  db.put("decision_memories/other-project", { id: "other-project", ownerWorkspaceId: workspaceId, projectId: "other", linkedRuleIds: ["target"], createdAt: createdAt(4) });

  assert.deepEqual((await drift.listForRule(workspaceId, userId, "target")).map((item) => item.id).sort(), ["accepted", "open"]);
  assert.deepEqual((await rules.listDecisionMemoriesForRule(workspaceId, userId, "project", "target")).map((item) => item.id), ["new", "old"]);
});

test("review queue is proposed-only and bounded; getMany preserves tenant visibility", async () => {
  const { db, store } = fixture(), rules = new RulesService(store), ctx = { workspaceId, actorUserId: userId };
  for (let index = 0; index < 120; index += 1) { db.put(`rules/rule-${index}`, { id: `rule-${index}`, ownerWorkspaceId: workspaceId, scopeType: "project", scopeId: "project", projectId: "project" }); db.put(`rule_versions/proposal-${index}`, { id: `proposal-${index}`, ownerWorkspaceId: workspaceId, ruleId: `rule-${index}`, status: "proposed", createdAt: createdAt(index) }); }
  db.put("rule_versions/approved", { id: "approved", ownerWorkspaceId: workspaceId, ruleId: "rule-approved", status: "approved", createdAt: createdAt(0) });
  db.put("rules/visible", { id: "visible", ownerWorkspaceId: workspaceId });
  db.put("rules/deleted", { id: "deleted", ownerWorkspaceId: workspaceId, deletedAt: createdAt(1) });
  db.put("rules/foreign", { id: "foreign", ownerWorkspaceId: "other" });

  const queue = await rules.listReviewQueue(workspaceId, userId);
  assert.equal(queue.length, 100);
  assert.equal(queue[0]!.id, "proposal-0");
  assert.ok(queue.every((version) => version.status === "proposed"));
  assert.deepEqual((await store.getMany(ctx, "rules", ["visible", "visible", "deleted", "foreign", "missing"])).map((rule) => rule.id), ["visible"]);
  assert.equal(db.getAllCalls, 3);
  await assert.rejects(store.listQuery(ctx, "rules", [], { limit: 0 }), (error: RuleStoreError) => error.code === "INVALID_QUERY_LIMIT");
  await assert.rejects(store.listQuery(ctx, "rules", [], { startAfter: "cursor" }), (error: RuleStoreError) => error.code === "INVALID_QUERY_CURSOR");
});
