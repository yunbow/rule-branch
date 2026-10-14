import assert from "node:assert/strict";
import test from "node:test";
import { getStatusLabel } from "../src/lib/labels.ts";
import { isAggregateArtifactPath } from "../src/lib/publication.ts";

test("UI-011 publication aggregate labels retain their prescribed tones", () => {
  assert.deepEqual(getStatusLabel("publicationState", "published"), { label: "反映確認済み", tone: "green" });
  assert.deepEqual(getStatusLabel("publicationState", "partially_published"), { label: "一部反映", tone: "amber" });
});
test("UI-011 identifies compiler aggregate artifact paths", () => {
  assert.equal(isAggregateArtifactPath(".rulebranch/rules/L2/example.md"), false);
  assert.equal(isAggregateArtifactPath(".rulebranch/rules/L2/_denied.md"), true);
  assert.equal(isAggregateArtifactPath("AGENTS.md"), true);
});
