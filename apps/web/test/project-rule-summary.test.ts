import test from "node:test";
import assert from "node:assert/strict";
import { projectRuleSummary } from "../src/lib/project-rule-summary.ts";

test("project summary counts current applicable rules and partial publication", () => {
  const rules = [
    { id: "candidate", status: "draft" },
    { id: "stale", status: "stale", currentVersionId: "v1" },
    { id: "ready", status: "active", currentVersionId: "v2" },
    { id: "excluded", status: "active", currentVersionId: "v3" },
    { id: "personal", status: "active", currentVersionId: "v1", enforcement: "personal" },
    { id: "archived", status: "archived", currentVersionId: "v1" },
    { id: "deleted", status: "draft", deletedAt: "now" },
  ];
  const states = {
    v1: { perRepository: [{ repositoryId: "a", state: "published" }, { repositoryId: "b", state: "pr_open" }] },
    v2: { perRepository: [{ repositoryId: "a", state: "published" }, { repositoryId: "foreign", state: "not_published" }] },
    v3: { perRepository: [] },
  };
  assert.deepEqual(projectRuleSummary(rules, states, new Set(["a", "b"])), { candidates: 1, stale: 1, unpublished: 1, published: 1 });
  assert.deepEqual(projectRuleSummary([], {}, new Set()), { candidates: 0, stale: 0, unpublished: 0, published: 0 });
});
