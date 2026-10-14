import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_PAGE_SIZE, countDecisionMemories, filterAndSortDecisionMemories,
  filterDecisionMemoriesForProject, formatDecisionDate, groupDecisionMemories,
  type DecisionMemoryRecord,
} from "../src/lib/decision-memory.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const dated = (days: number): string =>
  new Date(NOW - days * 86400000).toISOString();

const memories: DecisionMemoryRecord[] = [
  {
    id: "old", title: "Old v1", context: "Past", decision: "Old decision",
    consequences: "clarify", projectId: "p", linkedRuleIds: ["r"], createdAt: dated(91),
  },
  {
    id: "current", title: "Naming v2", context: "Past",
    decision: "Maintain PascalCase", consequences: "clarify", projectId: "p",
    linkedRuleIds: ["r"], createdAt: dated(2), approvedRuleVersionId: "approved-v2",
  },
  {
    id: "external", title: "External v1", context: "", decision: "Hidden",
    consequences: "", projectId: "other", linkedRuleIds: ["r"], createdAt: dated(3),
  },
  {
    id: "archived", title: "Removed rule v3", context: "", decision: "Archived reason",
    consequences: "change", projectId: "p", linkedRuleIds: ["deleted"],
    createdAt: dated(5),
  },
  {
    id: "legacy", title: "Legacy v4", context: "", decision: "Old system reason",
    consequences: "", projectId: null, linkedRuleIds: ["r"], createdAt: dated(17),
  },
  {
    id: "deleted-memory", title: "Deleted", context: "", decision: "Hidden",
    consequences: "", projectId: "p", linkedRuleIds: ["r"], deletedAt: dated(0),
    createdAt: dated(0),
  },
];
const rules = [{ id: "r", projectId: "p" }, { id: "from-other", projectId: "other" }];
const project = filterDecisionMemoriesForProject(memories, rules, "p");

test("stored project ID remains authoritative even without a current rule", () => {
  assert.deepEqual(project.map((memory) => memory.id),
    ["old", "current", "archived", "legacy"]);
  assert.equal(project.some((memory) => memory.id === "external"), false);
  assert.equal(project.some((memory) => memory.id === "deleted-memory"), false);
  assert.equal(filterDecisionMemoriesForProject([
    { projectId: "other", linkedRuleIds: ["r"] },
  ], rules, "p").length, 0);
});

test("legacy projectless records fall back to existing rule associations", () => {
  assert.equal(filterDecisionMemoriesForProject([
    { projectId: null, linkedRuleIds: ["r"] },
    { linkedRuleIds: ["not-found"] },
  ], rules, "p").length, 1);
});

test("summary counts recent records and unique associated rules without double counting", () => {
  assert.deepEqual(countDecisionMemories(project, NOW), {
    total: 4, recent30Days: 3, relatedRules: 2,
  });
});

test("filters search title, related rule, rationale and approval comment", () => {
  assert.deepEqual(filterAndSortDecisionMemories(project, {
    query: "NamiNG", now: NOW,
  }).map((memory) => memory.id), ["current"]);
  assert.deepEqual(filterAndSortDecisionMemories(project, {
    query: "archived reason", now: NOW,
  }).map((memory) => memory.id), ["archived"]);
  assert.deepEqual(filterAndSortDecisionMemories(project, {
    query: "naming convention", now: NOW, ruleTitles: { r: "Naming Convention" },
  }).map((memory) => memory.id), ["current", "legacy", "old"]);
  assert.deepEqual(filterAndSortDecisionMemories(project, {
    ruleId: "deleted", now: NOW,
  }).map((memory) => memory.id), ["archived"]);
});

test("time range is bounded by now and sorting retains deterministic order", () => {
  assert.deepEqual(filterAndSortDecisionMemories(project, { period: "7", now: NOW })
    .map((memory) => memory.id), ["current", "archived"]);
  assert.deepEqual(filterAndSortDecisionMemories(project, { period: "30", now: NOW })
    .map((memory) => memory.id), ["current", "archived", "legacy"]);
  assert.deepEqual(filterAndSortDecisionMemories(project, { sort: "oldest", now: NOW })
    .map((memory) => memory.id), ["old", "legacy", "archived", "current"]);
  assert.equal(filterAndSortDecisionMemories([{ ...project[0]!, createdAt: "bad" }],
    { period: "30", now: NOW }).length, 0);
});

test("grouped view contains every history item once, even for removed rules", () => {
  const groups = groupDecisionMemories(project, { r: "Naming Convention" });
  assert.deepEqual(groups.map((group) => group.title),
    ["Naming Convention", "以前の関連ルール（現在は確認できません）"]);
  assert.deepEqual(groups.flatMap((group) => group.memories.map((item) => item.id)),
    ["old", "current", "legacy", "archived"]);
});

test("pagination and dates use stable values independent of browser locale", () => {
  assert.equal(DECISION_PAGE_SIZE, 10);
  assert.match(formatDecisionDate("2026-10-10T18:00:00Z"), /10\/11/);
  assert.equal(formatDecisionDate("bad"), "日時不明");
});
