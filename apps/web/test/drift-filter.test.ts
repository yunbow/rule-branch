import test from "node:test";
import assert from "node:assert/strict";
import { filterFindings, matchesFindingPath } from "../src/lib/drift-filter.ts";

const sample = [
  { id: "a", status: "open", driftType: "artifact_mismatch", path: "AGENTS.md" },
  { id: "b", status: "accepted", driftType: "artifact_mismatch", filePath: ".github/instructions.md" },
  { id: "c", status: "open", driftType: "dependency_drift", path: "package.json" },
  { id: "d", status: "open", driftType: "artifact_mismatch" },
];

test("exact path and status filters respect publication deep links", () => {
  assert.equal(matchesFindingPath(sample[0], "AGENTS.md"), true);
  assert.equal(matchesFindingPath(sample[0], "agents.md"), false);
  const result = filterFindings(sample, ["open"], "artifact_mismatch", "AGENTS.md");
  assert.equal(result.pathMatched, true);
  assert.deepEqual(result.visible.map((item) => item.id), ["a"]);
});

test("legacy drift without structured path stays visible, but is not claimed as a match", () => {
  const result = filterFindings(sample, ["open"], "artifact_mismatch", "missing.md");
  assert.equal(result.pathMatched, false);
  assert.deepEqual(result.visible.map((item) => item.id), ["a", "d"]);
});

test("type and status are respected without a path", () => {
  const result = filterFindings(sample, ["accepted"], "artifact_mismatch");
  assert.equal(result.pathMatched, false);
  assert.deepEqual(result.visible.map((item) => item.id), ["b"]);
});
