import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const ctx = { workspaceId: "workspace-a", actorUserId: "user-a", actorKind: "user" as const };
function setup() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  db.put("projects/project", { id: "project", ownerWorkspaceId: "workspace-a", status: "active", deletedAt: null });
  const rule = (id: string, scopeType: string, enforcement = "default", status = "active") => db.put(`rules/${id}`, { id, ownerWorkspaceId: "workspace-a", scopeType, scopeId: scopeType === "organization" ? "workspace-a" : "project", enforcement, status });
  rule("parent", "organization"); rule("child", "project"); return { db, store, rule };
}
test("createRelation applies V1-V9 and reserves its child unique key", async () => {
  const { store } = setup();
  const relation = await store.createRelation(ctx, { parentRuleId: "parent", childRuleId: "child", relationType: "extend" });
  assert.equal(relation.validationStatus, "unchecked");
  await assert.rejects(store.createRelation(ctx, { parentRuleId: "parent", childRuleId: "child", relationType: "extend" }), (error: RuleStoreError) => error.code === "UNIQUE_VIOLATION");
  await assert.rejects(store.createRelation(ctx, { parentRuleId: "parent", childRuleId: "parent", relationType: "extend" }), (error: RuleStoreError) => error.code === "RELATION_SELF_REFERENCE");
});
test("relation validation rejects scope, locked override, and deny without rationale", async () => {
  let value = setup(); value.rule("bad-parent", "project");
  await assert.rejects(value.store.createRelation(ctx, { parentRuleId: "bad-parent", childRuleId: "child", relationType: "extend" }), (error: RuleStoreError) => error.code === "RELATION_SCOPE_INVALID");
  value = setup(); value.rule("locked", "organization", "locked");
  await assert.rejects(value.store.createRelation(ctx, { parentRuleId: "locked", childRuleId: "child", relationType: "override" }), (error: RuleStoreError) => error.code === "RELATION_ENFORCEMENT_INVALID");
  await assert.rejects(value.store.createRelation(ctx, { parentRuleId: "parent", childRuleId: "child", relationType: "deny" }), (error: RuleStoreError) => error.code === "RELATION_RATIONALE_REQUIRED");
});
