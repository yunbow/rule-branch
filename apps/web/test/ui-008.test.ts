import assert from "node:assert/strict";
import test from "node:test";
import { childRelationRules, parentRelationRules, relationRationaleError } from "../src/lib/relation-form.ts";

const rules = [
  { id: "parent", title: "Parent", scopeType: "organization", status: "active" },
  { id: "child", title: "Child", scopeType: "project", status: "draft", projectId: "p1" },
  { id: "archived-parent", title: "Archived", scopeType: "organization", status: "archived" },
  { id: "user", title: "User", scopeType: "user", status: "active" },
];

test("UI-008 filters parent and child candidates by scope and selectable status", () => {
  assert.deepEqual(parentRelationRules(rules).map((rule) => rule.id), ["parent"]);
  assert.deepEqual(childRelationRules(rules).map((rule) => rule.id), ["child"]);
});

test("UI-008 requires a <= 2000 character rationale only for deny", () => {
  assert.equal(relationRationaleError("override", ""), null);
  assert.equal(relationRationaleError("extend", ""), null);
  assert.equal(relationRationaleError("deny", ""), "RELATION_RATIONALE_REQUIRED");
  assert.equal(relationRationaleError("deny", "理由"), null);
  assert.equal(relationRationaleError("deny", "a".repeat(2001)), "RELATION_RATIONALE_REQUIRED");
});
