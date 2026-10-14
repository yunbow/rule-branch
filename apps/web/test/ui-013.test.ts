import assert from "node:assert/strict";
import test from "node:test";
import { filterSeedDocuments, parseSeedStage, stageForSeedDocument, type SeedDocument } from "../scripts/seed-stage.ts";

const documents: SeedDocument[] = [
  ["workspaces", "seed-workspaces-2", {}],
  ["analysis_jobs", "seed-analysis_jobs-2", {}],
  ["drift_findings", "seed-drift_findings-1", {}],
  ["drift_findings", "seed-drift_findings-5", {}],
  ["rule_versions", "seed-rule_versions-1", {}],
  ["rule_versions", "seed-ui006-rule_versions-2", {}],
  ["revision_prs", "seed-revision_prs-1", {}],
];

test("UI-013: stage 1 keeps only the minimum installation/bootstrap fixtures", () => {
  const seeded = filterSeedDocuments(documents, 1);
  assert.deepEqual(seeded.map(([, id]) => id), ["seed-workspaces-2"]);
  assert.ok(seeded.every((document) => stageForSeedDocument(document) === 1));
});

test("UI-013: stage 7 and no stage include every fixture", () => {
  assert.deepEqual(filterSeedDocuments(documents, 7), documents);
  assert.deepEqual(filterSeedDocuments(documents), documents);
  assert.equal(parseSeedStage(["--stage=7"]), 7);
  assert.throws(() => parseSeedStage(["--stage=8"]), /--stage/);
});
