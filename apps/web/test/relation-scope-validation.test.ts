import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uncoveredRelationFields } from "../src/shared/relation-scope.ts";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError, type DocumentData } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const cases = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../contracts/relation-coverage.json"), "utf8")) as
  Array<{ name: string; parent: DocumentData; child: DocumentData; uncovered: string[] }>;
for (const item of cases) test(`relation coverage contract: ${item.name}`, () => {
  assert.deepEqual(uncoveredRelationFields(item.parent, item.child), item.uncovered);
});

function fixture(parentSelector: DocumentData = {}, childSelector: DocumentData = {}) {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new RulesService(store);
  const workspaceId = "relation-ws", userId = "relation-owner";
  db.put(`workspaces/${workspaceId}`, { id: workspaceId, status: "active", kind: "organization" });
  db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, {
    id: `workspace_member:${workspaceId}:${userId}`, ownerWorkspaceId: workspaceId, targetId: "membership",
  });
  db.put("workspace_members/membership", { id: "membership", workspaceId, userId, role: "owner" });
  db.put("projects/project", { id: "project", ownerWorkspaceId: workspaceId, status: "active", deletedAt: null });
  db.put("repositories/repo", { id: "repo", ownerWorkspaceId: workspaceId, projectId: "project", status: "active", deletedAt: null });
  db.put("rules/parent", {
    id: "parent", ownerWorkspaceId: workspaceId, scopeType: "organization", scopeId: workspaceId,
    projectId: null, status: "active", enforcement: "default", currentVersionId: "parent-v",
    selector: parentSelector, title: "Organization policy",
  });
  db.put("rules/child", {
    id: "child", ownerWorkspaceId: workspaceId, scopeType: "project", scopeId: "project",
    projectId: "project", status: "active", enforcement: "default", currentVersionId: "child-v",
    selector: childSelector, title: "Project policy",
  });
  return { db, store, service, workspaceId, userId };
}
const relation = { parentRuleId: "parent", childRuleId: "child", relationType: "override" as const };

test("reject a narrower override before writing relation, reservation or compile intent", async () => {
  const f = fixture({}, { directoryGlobs: ["src/**"] });
  await assert.rejects(f.service.createRelation(f.workspaceId, f.userId, relation),
    (err: RuleStoreError) => err.code === "CONDITIONAL_RELATION_UNSUPPORTED" &&
      err.status === 422 && (err.details.fields as string[]).includes("directoryGlobs"));
  assert.deepEqual(await f.store.list({ workspaceId: f.workspaceId, actorUserId: f.userId }, "rule_relations"), []);
  assert.equal(f.db.snapshot("unique_keys", "rule_relation_child:child").exists, false);
  assert.equal(f.db.snapshot("rules", "child").data()?.compilePending, undefined);
});

test("a relation accepts repository-only scoping and an extend may be conditional", async () => {
  const f = fixture({}, { repositoryIds: ["repo"] });
  await f.service.createRelation(f.workspaceId, f.userId, relation);
  assert.equal((await f.store.list({ workspaceId: f.workspaceId, actorUserId: f.userId }, "rule_relations")).length, 1);
  const other = fixture({}, { directoryGlobs: ["src/**"] });
  const added = await other.service.createRelation(other.workspaceId, other.userId, { ...relation, relationType: "extend" });
  assert.equal(added.relationType, "extend");
});

test("selector edits cannot narrow an existing child exception", async () => {
  const f = fixture();
  await f.service.createRelation(f.workspaceId, f.userId, relation);
  await assert.rejects(f.service.updateRuleMetadata(f.workspaceId, f.userId, "child",
    { selector: { directoryGlobs: ["src/**"] } }),
    (err: RuleStoreError) => err.code === "CONDITIONAL_RELATION_UNSUPPORTED");
  assert.deepEqual(f.db.snapshot("rules", "child").data()?.selector, {});
});

test("selector edits cannot broaden an existing parent outside its child", async () => {
  const f = fixture({ languages: ["TypeScript"] }, { languages: ["typescript"] });
  await f.service.createRelation(f.workspaceId, f.userId, relation);
  await assert.rejects(f.service.updateRuleMetadata(f.workspaceId, f.userId, "parent",
    { selector: {} }),
    (err: RuleStoreError) => err.code === "CONDITIONAL_RELATION_UNSUPPORTED");
  assert.deepEqual(f.db.snapshot("rules", "parent").data()?.selector, { languages: ["TypeScript"] });
  const renamed = await f.service.updateRuleMetadata(f.workspaceId, f.userId, "parent", { title: "Updated organization policy" });
  assert.equal(renamed.title, "Updated organization policy");
});
