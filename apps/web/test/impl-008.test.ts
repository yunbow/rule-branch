import assert from "node:assert/strict";
import test from "node:test";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), workspaceId = "workspace-a", userId = "user-a";
  await store.runTransaction(async (tx) => { tx.create(store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`), { targetId: "member", ownerWorkspaceId: workspaceId }); tx.create(store.documentRef("workspace_members", "member"), { role: "owner", ownerWorkspaceId: workspaceId }); });
  return { db, store, service: new RulesService(store), workspaceId, userId };
}
const input = { key: "l1.security", scopeType: "organization", scopeId: "workspace-a", layer: "L1", type: "security", evaluationMode: "semantic", enforcement: "default", title: "Security" };
const version = { content: "Use TLS", rationale: "security", changeType: "initial" };
test("project selectors reject removed repositories on create and metadata update", async () => {
  const f = await fixture();
  f.db.put("projects/project", { id: "project", ownerWorkspaceId: f.workspaceId, status: "active", deletedAt: null });
  for (const status of ["active", "removed"]) f.db.put("repositories/" + status, {
    id: status, ownerWorkspaceId: f.workspaceId, projectId: "project", status,
  });
  const projectInput = { ...input, scopeType: "project", scopeId: "project", projectId: "project" };
  const invalid = (error: RuleStoreError) => error.code === "INVALID_SELECTOR_REPOSITORIES" && error.status === 422;
  await assert.rejects(f.service.createRule(f.workspaceId, f.userId, { ...projectInput, selector: { repositoryIds: ["removed"] } }), invalid);
  const rule = await f.service.createRule(f.workspaceId, f.userId, { ...projectInput, selector: { repositoryIds: ["active"] } });
  await assert.rejects(f.service.updateRuleMetadata(f.workspaceId, f.userId, String(rule.id), { selector: { repositoryIds: ["removed"] } }), invalid);
  const saved = await f.service.getRule(f.workspaceId, f.userId, String(rule.id));
  assert.deepEqual(saved.selector, rule.selector);
  // Existing references to unlinked repositories can be removed without broadening silently.
  f.db.put("rules/" + rule.id, { ...rule, selector: { repositoryIds: ["removed"] } });
  const updated = await f.service.updateRuleMetadata(f.workspaceId, f.userId, String(rule.id), { selector: { repositoryIds: ["active"] } });
  assert.deepEqual(updated.selector, rule.selector);
});
test("rule starts at nextVersion one without a version, then creates immutable versions", async () => {
  const f = await fixture(), rule = await f.service.createRule(f.workspaceId, f.userId, input);
  assert.equal(rule.nextVersion, 1); assert.equal(rule.transferPolicy, "exportable"); assert.equal((await f.service.listRuleVersions(f.workspaceId, f.userId)).length, 0);
  const created = await f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, version); assert.equal(created.version, 1); assert.equal((await f.service.getRule(f.workspaceId, f.userId, rule.id as string)).nextVersion, 2);
  await assert.rejects(f.service.updateRuleVersion(f.workspaceId, f.userId, created.id as string, { content: "no" }), (error: RuleStoreError) => error.code === "IMMUTABLE_FIELD");
  await assert.rejects(f.service.createRule(f.workspaceId, f.userId, { ...input, key: "managed", nextVersion: 9 }), (error: RuleStoreError) => error.code === "IMMUTABLE_FIELD");
});
test("rule validation covers uniqueness, scope, selector, deterministic checks and AI evidence", async () => {
  const f = await fixture(); await f.service.createRule(f.workspaceId, f.userId, input);
  await assert.rejects(f.service.createRule(f.workspaceId, f.userId, input), (error: RuleStoreError) => error.status === 409);
  for (const invalid of [{ ...input, key: "user", scopeType: "user", scopeId: "user-a" }, { ...input, key: "locked", scopeType: "project", scopeId: "project", projectId: "project", enforcement: "locked" }, { ...input, key: "team", scopeType: "team" }, { ...input, key: "repos", selector: { repositoryIds: ["x"] } }, { ...input, key: "many", selector: { repositoryIds: Array(51).fill("x") } }, { ...input, key: "det", evaluationMode: "deterministic" }]) await assert.rejects(f.service.createRule(f.workspaceId, f.userId, invalid), (error: RuleStoreError) => error.status === 422);
  const rule = await f.service.createRule(f.workspaceId, f.userId, { ...input, key: "ai" }); await assert.rejects(f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, { ...version, provenance: { sourceType: "ai" } }), (error: RuleStoreError) => error.code === "EVIDENCE_REQUIRED");
});
test("rule checks accept only schema fields and server-own identity and governance fields", async () => {
  const f = await fixture();
  const base = { ...input, key: "det-checks", evaluationMode: "deterministic" };
  await assert.rejects(
    f.service.createRule(f.workspaceId, f.userId, { ...base, checks: [{ kind: "regex", spec: { pattern: "x" }, id: "attacker-id", ownerWorkspaceId: "other", ruleId: "other" }] }),
    (error: RuleStoreError) => error.code === "INVALID_RULE_CHECK" && error.status === 422,
  );
  for (const [key, check] of [
    ["bad-kind", { kind: "shell", spec: {} }],
    ["bad-spec", { kind: "regex", spec: "not-an-object" }],
    ["bad-severity", { kind: "regex", spec: {}, severityOnFail: "fatal" }],
    ["bad-enabled", { kind: "regex", spec: {}, enabled: "yes" }],
  ] as const) await assert.rejects(f.service.createRule(f.workspaceId, f.userId, { ...base, key, checks: [check as never] }), (error: RuleStoreError) => error.code === "INVALID_RULE_CHECK");

  const rule = await f.service.createRule(f.workspaceId, f.userId, { ...base, checks: [{ kind: "regex", spec: { pattern: "^safe$" } }] });
  const stored = f.db.query("rule_checks", [])[0]!.data()!;
  assert.deepEqual({ kind: stored.kind, spec: stored.spec, severityOnFail: stored.severityOnFail, enabled: stored.enabled }, { kind: "regex", spec: { pattern: "^safe$" }, severityOnFail: "warning", enabled: true });
  assert.equal(stored.ownerWorkspaceId, f.workspaceId); assert.equal(stored.ruleId, rule.id); assert.notEqual(stored.id, "attacker-id");
  assert.deepEqual(stored.createdBy, { kind: "user", id: f.userId }); assert.equal(stored.deletedAt, null);
});
test("rule scope IDs must match their organization, project, or creating user", async () => {
  const f = await fixture();
  await f.store.runTransaction(async (tx) => tx.create(f.store.documentRef("projects", "project-a"), { id: "project-a", ownerWorkspaceId: f.workspaceId, status: "active", deletedAt: null }));
  const cases = [
    { scopeType: "organization", scopeId: f.workspaceId, expectedScopeId: "other-workspace", projectId: undefined },
    { scopeType: "project", scopeId: "project-a", expectedScopeId: "other-project", projectId: "project-a" },
    { scopeType: "user", scopeId: f.userId, expectedScopeId: "other-user", projectId: undefined },
  ];
  for (const [index, scope] of cases.entries()) {
    await assert.rejects(f.service.createRule(f.workspaceId, f.userId, { ...input, key: `bad-scope-${index}`, scopeType: scope.scopeType, scopeId: scope.expectedScopeId, projectId: scope.projectId, enforcement: scope.scopeType === "user" ? "personal" : "default", type: scope.scopeType === "user" ? "interaction" : "security" }), (error: RuleStoreError) => error.status === 422 && error.code === "INVALID_RULE" && error.details.field === "scopeId");
    const rule = await f.service.createRule(f.workspaceId, f.userId, { ...input, key: `valid-scope-${index}`, scopeType: scope.scopeType, scopeId: scope.scopeId, projectId: scope.projectId, enforcement: scope.scopeType === "user" ? "personal" : "default", type: scope.scopeType === "user" ? "interaction" : "security" });
    assert.equal(rule.scopeId, scope.scopeId);
  }
});
test("supersedes withdraws the old proposal and transfers D8 findings", async () => {
  const f = await fixture(), rule = await f.service.createRule(f.workspaceId, f.userId, input), old = await f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, version);
  await f.store.runTransaction(async (tx) => tx.create(f.store.documentRef("drift_findings", "finding"), { id: "finding", ownerWorkspaceId: f.workspaceId, ruleId: rule.id, proposalVersionId: old.id }));
  const newer = await f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, { ...version, changeType: "clarify", supersedes: old.id as string });
  assert.equal((await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.userId }, "rule_versions", old.id as string))!.status, "withdrawn"); assert.equal((await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.userId }, "drift_findings", "finding"))!.proposalVersionId, newer.id);
});
test("concurrent version creation allocates distinct gapless versions", async () => {
  const f = await fixture(), rule = await f.service.createRule(f.workspaceId, f.userId, input);
  const results = await Promise.all([f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, version), f.service.createRuleVersion(f.workspaceId, f.userId, rule.id as string, { ...version, changeType: "clarify" })]);
  assert.deepEqual(results.map((item) => item.version).sort(), [1, 2]); assert.equal((await f.service.getRule(f.workspaceId, f.userId, rule.id as string)).nextVersion, 3);
});

test("compiler-facing rule enums and required title reject malformed API input before any write", async () => {
  const f = await fixture();
  const violations = [
    ["layer", "L4"], ["type", "not-a-type"], ["evaluationMode", "never"],
    ["enforcement", "super-locked"], ["transferPolicy", "anything"],
    ["licenseType", "unknown-license"], ["visibility", "mystery"], ["title", ""],
  ] as const;
  for (const [field, value] of violations) {
    const auditCount = f.db.query("audit_logs", []).length;
    const count = f.db.query("rules", []).length;
    await assert.rejects(
      f.service.createRule(f.workspaceId, f.userId, { ...input, key: `invalid-${field.toLowerCase()}`, [field]: value }),
      (error: RuleStoreError) => error.code === "INVALID_RULE" && error.status === 422 && error.details.field === field,
    );
    assert.equal(f.db.query("audit_logs", []).length, auditCount);
    assert.equal(f.db.query("rules", []).length, count);
  }
});

test("maintenance partial updates preserve dependency watches until explicitly cleared", async () => {
  const f = await fixture();
  const rule = await f.service.createRule(f.workspaceId, f.userId, {
    ...input, key: "watch-dependencies",
    maintenance: { reviewIntervalDays: 30, watchDependencies: ["zod", "typescript"] },
  });
  const id = String(rule.id);
  const changed = await f.service.updateRuleMetadata(f.workspaceId, f.userId, id, {
    maintenance: { reviewIntervalDays: 60 },
  });
  assert.deepEqual((changed.maintenance as { watchDependencies: string[] }).watchDependencies, ["zod", "typescript"]);
  assert.equal((changed.maintenance as { reviewIntervalDays: number }).reviewIntervalDays, 60);
  await f.service.updateRuleMetadata(f.workspaceId, f.userId, id, {
    maintenance: { watchDependencies: [] },
  });
  const cleared = await f.service.getRule(f.workspaceId, f.userId, id);
  assert.deepEqual((cleared.maintenance as { watchDependencies: string[] }).watchDependencies, []);
  assert.equal((cleared.maintenance as { reviewIntervalDays: number }).reviewIntervalDays, 60);
  await assert.rejects(f.service.updateRuleMetadata(f.workspaceId, f.userId, id, {
    maintenance: null,
  }), (error: RuleStoreError) => error.code === "INVALID_MAINTENANCE" && error.status === 422);
});
