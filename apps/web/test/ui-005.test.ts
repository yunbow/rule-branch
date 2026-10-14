import assert from "node:assert/strict";
import test from "node:test";
import { filterRules } from "../src/lib/rule-list.ts";
import { canApproveRuleVersion } from "../src/shared/permissions.ts";

const rules = [
  { id: "1", title: "Alpha", key: "alpha", layer: "L1", enforcement: "default", status: "draft", type: "guideline" },
  { id: "2", title: "Beta", key: "beta", layer: "L2", enforcement: "locked", status: "active", type: "security" },
  { id: "3", title: "Gamma", key: "gamma", layer: "L3", enforcement: "advisory", status: "archived", type: "guideline" },
];
test("UI-005 rule tabs and filters are pure client-side filtering", () => {
  assert.deepEqual(filterRules(rules, "draft", { layer: "", enforcement: "", type: "", query: "" }).map((rule) => rule.id), ["1"]);
  assert.deepEqual(filterRules(rules, "other", { layer: "", enforcement: "", type: "", query: "" }).map((rule) => rule.id), ["3"]);
  assert.deepEqual(filterRules(rules, "all", { layer: "L2", enforcement: "locked", type: "security", query: "bet" }).map((rule) => rule.id), ["2"]);
});
test("UI-005 approval button follows personal, locked, and project default/advisory policy", () => {
  assert.equal(canApproveRuleVersion({ workspaceKind: "personal", enforcement: "locked", scopeType: "organization" }, "owner"), true);
  assert.equal(canApproveRuleVersion({ workspaceKind: "personal", enforcement: "default", scopeType: "project" }, "admin"), false);
  assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "locked", scopeType: "project" }, "maintainer"), false);
  assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "locked", scopeType: "project" }, "admin"), true);
  assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "advisory", scopeType: "project" }, "maintainer"), true);
  assert.equal(canApproveRuleVersion({ workspaceKind: "organization", enforcement: "default", scopeType: "organization" }, "owner"), true);
});
