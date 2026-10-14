import assert from "node:assert/strict";
import test from "node:test";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError, type DocumentData } from "../src/shared/rulestore.ts";

const workspaceId = "review-workspace", userId = "review-owner";
const ctx = { workspaceId, actorUserId: userId, actorKind: "user" as const };

/** The actual service/store methods run against an atomic storage port.
 * No method that implements approval or metadata validation is mocked. */
function fixture(status: unknown = "active") {
  const records = new Map<string, DocumentData>();
  const put = (table: string, id: string, value: DocumentData) => records.set(`${table}/${id}`, structuredClone(value));
  put("workspaces", workspaceId, { id: workspaceId, ownerWorkspaceId: workspaceId, kind: "organization", status: "active" });
  put("unique_keys", `workspace_member:${workspaceId}:${userId}`, { targetId: "member" });
  put("workspace_members", "member", { role: "owner" });
  put("projects", "project", { id: "project", ownerWorkspaceId: workspaceId, status: "active" });
  put("repositories", "repo", { id: "repo", ownerWorkspaceId: workspaceId, projectId: "project", status: "active" });
  put("rules", "rule", { id: "rule", ownerWorkspaceId: workspaceId, scopeType: "organization", scopeId: workspaceId,
    projectId: null, status, enforcement: "locked", currentVersionId: "current", title: "Security", selector: {}, provenance: {} });
  put("rule_versions", "current", { id: "current", ownerWorkspaceId: workspaceId, ruleId: "rule", version: 1, status: "approved", rationale: "old" });
  put("rule_versions", "proposal", { id: "proposal", ownerWorkspaceId: workspaceId, ruleId: "rule", version: 2,
    status: "proposed", content: "Use TLS", rationale: "Reviewed", changeType: "clarify", evidenceIds: [], driftFindingIds: [] });
  const snapshot = (key: string, source = records) => ({ exists: source.has(key), id: key.split("/").at(-1)!, data: () => structuredClone(source.get(key)) });
  const ref = (table: string, id: string) => ({ key: `${table}/${id}`, id, get: async () => snapshot(`${table}/${id}`) });
  let commits = 0, dispatches = 0, serial = 0;
  const port = {
    ref, documentRef: ref,
    beforeTransaction: null as (() => void) | null,
    get: async (_ctx: unknown, table: string, id: string) => structuredClone(records.get(`${table}/${id}`) ?? null),
    list: async (_ctx: unknown, table: string, filters: DocumentData = {}) => [...records.entries()]
      .filter(([key, value]) => key.startsWith(`${table}/`) && Object.entries(filters).every(([field, expected]) => value[field] === expected))
      .map(([, value]) => structuredClone(value)),
    runTransaction: async <T>(callback: (tx: any) => Promise<T>): Promise<T> => {
      const before = port.beforeTransaction; port.beforeTransaction = null; before?.();
      const staged = structuredClone(records);
      const tx = {
        get: async (reference: ReturnType<typeof ref>) => snapshot(reference.key, staged),
        update: (reference: ReturnType<typeof ref>, value: DocumentData) => {
          assert.ok(staged.has(reference.key)); staged.set(reference.key, { ...staged.get(reference.key), ...structuredClone(value) });
        },
        create: (reference: ReturnType<typeof ref>, value: DocumentData) => {
          assert.ok(!staged.has(reference.key)); staged.set(reference.key, structuredClone(value));
        },
      };
      const result = await callback(tx);
      records.clear(); for (const [key, value] of staged) records.set(key, value);
      commits += 1;
      return result;
    },
    appendAuditLog: async (_ctx: unknown, entry: DocumentData, tx: any) => tx.create(ref("audit_logs", `audit-${++serial}`), entry),
    onRuleVersionApproved: async () => { dispatches += 1; },
    flushRuleCompilations: async () => { dispatches += 1; },
  };
  const store = port as unknown as FirestoreRuleStore;
  return { records, put, port, store, service: new RulesService(store),
    counts: () => ({ commits, dispatches }),
    approve: (restoreArchived = false) => FirestoreRuleStore.prototype.approveRuleVersion.call(store, ctx, "proposal", { restoreArchived }),
  };
}

for (const status of ["deprecated", "superseded", "archived", "unknown", null, undefined]) {
  test(`normal approval rejects parent status ${String(status)} without side effects`, async () => {
    const f = fixture(); f.records.get("rules/rule")!.status = status;
    const before = structuredClone(f.records);
    await assert.rejects(f.approve(), (error: RuleStoreError) => error.code === "RULE_STATUS_INVALID" && error.status === 422);
    assert.deepEqual(f.records, before);
    assert.deepEqual(f.counts(), { commits: 0, dispatches: 0 });
  });
}

for (const status of ["draft", "active", "stale"]) {
  test(`normal approval retains the valid ${status} path`, async () => {
    const f = fixture(status);
    await f.approve();
    assert.equal(f.records.get("rules/rule")!.currentVersionId, "proposal");
    assert.equal(f.records.get("rules/rule")!.status, "active");
    assert.equal(f.records.get("rule_versions/current")!.status, "superseded");
    assert.equal(f.records.get("rule_versions/proposal")!.status, "approved");
    assert.equal(f.records.get("rule_versions/proposal")!.compilePending, true);
    assert.equal([...f.records.keys()].filter(key => key.startsWith("decision_memories/")).length, 1);
    assert.deepEqual(f.counts(), { commits: 1, dispatches: 1 });
  });
}

test("the explicit restoration path only permits archived parents", async () => {
  for (const status of ["deprecated", "superseded", "active", "stale", "draft"]) {
    const f = fixture(status), before = structuredClone(f.records);
    await assert.rejects(f.approve(true), (error: RuleStoreError) => error.code === "RULE_STATUS_INVALID");
    assert.deepEqual(f.records, before);
    assert.deepEqual(f.counts(), { commits: 0, dispatches: 0 });
  }
  const f = fixture("archived"); await f.approve(true);
  assert.equal(f.records.get("rules/rule")!.status, "active");
  assert.equal(f.records.get("rules/rule")!.currentVersionId, "proposal");
});

test("concurrent deprecation is checked inside the approval transaction", async () => {
  const f = fixture();
  f.port.beforeTransaction = () => { f.records.get("rules/rule")!.status = "deprecated"; };
  await assert.rejects(f.approve(), (error: RuleStoreError) => error.code === "RULE_STATUS_INVALID");
  assert.equal(f.records.get("rules/rule")!.status, "deprecated");
  assert.equal(f.records.get("rules/rule")!.currentVersionId, "current");
  assert.equal(f.records.get("rule_versions/current")!.status, "approved");
  assert.equal(f.records.get("rule_versions/proposal")!.status, "proposed");
  assert.deepEqual(f.counts(), { commits: 0, dispatches: 0 });
});

const badTitles: unknown[] = [{ text: "invalid" }, [], ["invalid"], null, undefined, 42, true, "", " \t\n", "　", "x".repeat(161)];
for (const [index, title] of badTitles.entries()) {
  test(`metadata rejects invalid title ${index} without persisting or auditing`, async () => {
    const f = fixture(), before = structuredClone(f.records);
    await assert.rejects(f.service.updateRuleMetadata(workspaceId, userId, "rule", { title }),
      (error: RuleStoreError) => error.code === "INVALID_RULE" && error.status === 422 && error.details.field === "title");
    assert.deepEqual(f.records, before);
    assert.deepEqual(f.counts(), { commits: 0, dispatches: 0 });
  });
}

for (const title of ["修正済みタイトル", "x".repeat(160)]) {
  test(`metadata accepts a valid title of length ${title.length}`, async () => {
    const f = fixture();
    const updated = await f.service.updateRuleMetadata(workspaceId, userId, "rule", { title });
    assert.equal(updated.title, title);
    assert.equal(f.records.get("rules/rule")!.title, title);
    assert.deepEqual(f.counts(), { commits: 1, dispatches: 0 });
  });
}

test("metadata updates without a title remain valid", async () => {
  const f = fixture();
  const updated = await f.service.updateRuleMetadata(workspaceId, userId, "rule", { tags: ["security"] });
  assert.equal(updated.title, "Security");
  assert.deepEqual(updated.tags, ["security"]);
});
