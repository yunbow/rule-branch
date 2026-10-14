import assert from "node:assert/strict";
import test from "node:test";
import { filterDecisionMemoriesForProject } from "../src/lib/decision-memory.ts";

test("UI-012 は linkedRuleIds を逆引きして対象 Project の Decision Memory のみ表示する", () => {
  const rules = [{ id: "rule-a", projectId: "project-a" }, { id: "rule-b", projectId: "project-b" }];
  const memories = [{ linkedRuleIds: ["rule-a"] }, { linkedRuleIds: ["rule-b"] }, { linkedRuleIds: ["removed-rule"] }, { linkedRuleIds: ["rule-b", "rule-a"] }];
  assert.deepEqual(filterDecisionMemoriesForProject(memories, rules, "project-a"), [memories[0], memories[3]]);
});
