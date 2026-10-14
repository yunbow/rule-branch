import assert from "node:assert/strict";
import test from "node:test";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), workspaceId = "workspace-009", userId = "owner-009";
  await store.runTransaction(async (tx) => { tx.create(store.documentRef("workspaces", workspaceId), { id: workspaceId, kind: "organization" }); tx.create(store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`), { targetId: "member-009", ownerWorkspaceId: workspaceId }); tx.create(store.documentRef("workspace_members", "member-009"), { role: "owner", ownerWorkspaceId: workspaceId }); });
  const service = new RulesService(store);
  const rule = await service.createRule(workspaceId, userId, { key: "security-009", scopeType: "organization", scopeId: workspaceId, layer: "L1", type: "security", evaluationMode: "semantic", enforcement: "locked", title: "Security" });
  return { db, store, service, workspaceId, userId, rule };
}
const proposed = { content: "Use TLS", rationale: "TLS is required", changeType: "initial", evidenceIds: ["evidence-1"], driftFindingIds: ["finding-1"] };

test("rule integration rejects invalid targets without changing the source or audit log", async () => {
  const f = await fixture(), id = String(f.rule.id);
  f.db.put("rules/" + id, { ...f.rule, status: "active" });
  const target = { ...f.rule, id: "target", key: "target", status: "active" };
  for (const [name, changes] of [
    ["deprecated", { status: "deprecated" }], ["archived", { status: "archived" }],
    ["draft", { status: "draft" }], ["superseded", { status: "superseded" }],
    ["deleted", { deletedAt: new Date().toISOString() }],
    ["other-workspace", { ownerWorkspaceId: "other" }],
    ["other-scope", { scopeType: "project", scopeId: "project", projectId: "project" }],
    ["other-scope-id", { scopeId: "other" }], ["other-project", { projectId: "other" }],
  ] as const) {
    f.db.put("rules/target", { ...target, ...changes });
    await assert.rejects(f.service.updateRuleStatus(f.workspaceId, f.userId, id, "superseded", { supersededByRuleId: "target" }),
      (e: RuleStoreError) => e.code === "SUPERSEDED_BY_RULE_INVALID" && e.status === 422, name);
  }
  for (const targetId of [id, "missing"]) await assert.rejects(
    f.service.updateRuleStatus(f.workspaceId, f.userId, id, "superseded", { supersededByRuleId: targetId }),
    (e: RuleStoreError) => e.code === "SUPERSEDED_BY_RULE_INVALID");
  assert.equal((await f.service.getRule(f.workspaceId, f.userId, id)).status, "active");
  assert.equal(f.db.query("audit_logs", []).length, 1);
  f.db.put("rules/target", { ...target, status: "stale" });
  const merged = await f.service.updateRuleStatus(f.workspaceId, f.userId, id, "superseded", { supersededByRuleId: "target", rationale: "Integrated" });
  assert.equal(merged.status, "superseded");
  assert.equal(merged.supersededByRuleId, "target");
  assert.equal(f.db.query("audit_logs", []).length, 2);
});

test("integration revalidates the target inside the transaction after a concurrent deprecation", async () => {
  const f = await fixture(), id = String(f.rule.id);
  f.db.put("rules/" + id, { ...f.rule, status: "active" });
  const target = { ...f.rule, id: "target", status: "active" };
  f.db.put("rules/target", target);
  const runTransaction = f.store.runTransaction.bind(f.store);
  f.store.runTransaction = async (callback) => {
    f.db.put("rules/target", { ...target, status: "deprecated" });
    return runTransaction(callback);
  };
  await assert.rejects(f.service.updateRuleStatus(f.workspaceId, f.userId, id, "superseded", { supersededByRuleId: "target" }),
    (e: RuleStoreError) => e.code === "SUPERSEDED_BY_RULE_INVALID");
  assert.equal((await f.service.getRule(f.workspaceId, f.userId, id)).status, "active");
  assert.equal(f.db.query("audit_logs", []).length, 1);
});

test("approval is human-only, resolves linked findings, creates K12 memory and moves draft active", async () => {
  const f = await fixture();
  await f.store.runTransaction(async (tx) => tx.create(f.store.documentRef("drift_findings", "finding-1"), { id: "finding-1", ownerWorkspaceId: f.workspaceId, ruleId: f.rule.id, status: "accepted", severity: "high", confidence: .9, reopenCount: 0 }));
  const version = await f.store.createRuleVersion({ workspaceId: f.workspaceId, actorUserId: f.userId, actorKind: "user" }, f.rule.id as string, proposed);
  await assert.rejects(f.store.approveRuleVersion({ workspaceId: f.workspaceId, actorUserId: null, actorKind: "ai" }, version.id as string), (e: RuleStoreError) => e.code === "FORBIDDEN");
  await f.service.approveRuleVersion(f.workspaceId, f.userId, version.id as string, { comment: "reviewed" });
  const rule = await f.service.getRule(f.workspaceId, f.userId, f.rule.id as string), finding = await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.userId }, "drift_findings", "finding-1"), memories = await f.service.listDecisionMemories(f.workspaceId, f.userId);
  assert.equal(rule.status, "active"); assert.equal(rule.currentVersionId, version.id); assert.equal(finding!.status, "resolved"); assert.equal(finding!.resolvedByRuleVersionId, version.id); assert.equal(memories.length, 1); assert.equal(memories[0].sourceType, "approval"); assert.match(memories[0].consequences as string, /reviewed/);
});

test("reject reopens accepted proposal findings and transition inputs are enforced", async () => {
  const f = await fixture(), version = await f.service.createRuleVersion(f.workspaceId, f.userId, f.rule.id as string, { ...proposed, driftFindingIds: [] });
  await f.store.runTransaction(async (tx) => tx.create(f.store.documentRef("drift_findings", "finding-2"), { id: "finding-2", ownerWorkspaceId: f.workspaceId, ruleId: f.rule.id, status: "accepted", proposalVersionId: version.id, reopenCount: 2 }));
  await assert.rejects(f.service.rejectRuleVersion(f.workspaceId, f.userId, version.id as string, ""), (e: RuleStoreError) => e.status === 422);
  await f.service.rejectRuleVersion(f.workspaceId, f.userId, version.id as string, "not now");
  const finding = await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.userId }, "drift_findings", "finding-2"); assert.equal(finding!.status, "open"); assert.equal(finding!.proposalVersionId, null); assert.equal(finding!.reopenCount, 3);
  await f.store.runTransaction(async (tx) => tx.update(f.store.documentRef("rules", f.rule.id as string), { status: "active" }));
  await assert.rejects(f.service.updateRuleStatus(f.workspaceId, f.userId, f.rule.id as string, "deprecated"), (e: RuleStoreError) => e.code === "RATIONALE_REQUIRED");
  await assert.rejects(f.service.updateRuleStatus(f.workspaceId, f.userId, f.rule.id as string, "superseded"), (e: RuleStoreError) => e.code === "SUPERSEDED_BY_RULE_REQUIRED");
});

test("only a human proposal's creator can explicitly withdraw it", async () => {
  const f = await fixture(), otherUserId = "other-member";
  await f.store.runTransaction(async (tx) => {
    tx.create(f.store.documentRef("unique_keys", `workspace_member:${f.workspaceId}:${otherUserId}`), { targetId: "member-other", ownerWorkspaceId: f.workspaceId });
    tx.create(f.store.documentRef("workspace_members", "member-other"), { role: "member", ownerWorkspaceId: f.workspaceId });
  });
  const own = await f.service.createRuleVersion(f.workspaceId, f.userId, f.rule.id as string, proposed);
  await assert.rejects(f.service.withdrawRuleVersion(f.workspaceId, otherUserId, own.id as string), (e: RuleStoreError) => e.code === "FORBIDDEN");
  assert.equal((await f.service.withdrawRuleVersion(f.workspaceId, f.userId, own.id as string)).status, "withdrawn");

  const ai = await f.store.createRuleVersion({ workspaceId: f.workspaceId, actorUserId: null, actorKind: "ai" }, f.rule.id as string, { ...proposed, driftFindingIds: [], provenance: { sourceType: "ai" } });
  await assert.rejects(f.service.withdrawRuleVersion(f.workspaceId, f.userId, ai.id as string), (e: RuleStoreError) => e.code === "FORBIDDEN");
  const replacement = await f.service.createRuleVersion(f.workspaceId, f.userId, f.rule.id as string, { ...proposed, supersedes: ai.id as string });
  assert.equal((await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.userId }, "rule_versions", ai.id as string))!.status, "withdrawn");
  assert.equal(replacement.supersedes, ai.id);
});

test("archived rule restore activates and approves atomically before compiling", async () => {
  const f = await fixture(), id = String(f.rule.id);
  f.db.put(`rules/${id}`, { ...f.rule, status: "archived" });
  f.db.put("projects/project-restore", { id: "project-restore", ownerWorkspaceId: f.workspaceId, status: "active" });
  f.db.put("repositories/repo-restore", { id: "repo-restore", ownerWorkspaceId: f.workspaceId, projectId: "project-restore", status: "active" });
  const proposedVersion = await f.service.createRuleVersion(f.workspaceId, f.userId, id, {
    content: "Restore rule", rationale: "reviewed", changeType: "clarify",
  });
  const jobCreation = f.store.createAnalysisJob.bind(f.store);
  f.store.createAnalysisJob = async (ctx, input) => {
    const snapshot = f.db.snapshot("rules", id).data();
    assert.equal(snapshot?.status, "active", "compile dispatch must observe active rule");
    return jobCreation(ctx, input);
  };
  const restored = await f.service.updateRuleStatus(f.workspaceId, f.userId, id, "active",
    { approvedVersionId: proposedVersion.id as string, requestId: "restore-test" });
  assert.equal(restored.status, "active");
  assert.equal(restored.currentVersionId, proposedVersion.id);
  assert.equal(f.db.query("analysis_jobs", []).length, 1);
  const audits = f.db.query("audit_logs", []).map(item => item.data()!.action);
  assert.ok(audits.includes("rule.status_change"));
  assert.ok(audits.includes("rule_version.approve"));
  const again = await f.service.updateRuleStatus(f.workspaceId, f.userId, id, "active",
    { approvedVersionId: proposedVersion.id as string, requestId: "restore-test" });
  assert.equal(again.status, "active");
  assert.equal(f.db.query("analysis_jobs", []).length, 1);
});
