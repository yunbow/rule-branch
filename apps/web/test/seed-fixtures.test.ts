import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDemoSeedDocuments } from "../scripts/seed-fixtures.ts";
import { filterSeedDocuments, parseSeedStage, type DemoStage, type SeedDocument } from "../scripts/seed-stage.ts";

const at = new Date("2026-01-01T00:00:00.000Z");
const stages: DemoStage[] = [1, 2, 3, 4, 5, 6, 7];
const scalarReferences: Record<string, string> = {
  ownerWorkspaceId: "workspaces", workspaceId: "workspaces", personalWorkspaceId: "workspaces",
  userId: "users", ownerUserId: "users", invitedByUserId: "users",
  projectId: "projects", repositoryId: "repositories", installationId: "installations",
  ruleId: "rules", currentVersionId: "rule_versions", ruleVersionId: "rule_versions",
  proposalVersionId: "rule_versions", driftFindingId: "drift_findings",
  resolutionSnapshotId: "resolution_snapshots", revisionPrId: "revision_prs",
};
const arrayReferences: Record<string, string> = {
  evidenceIds: "evidence", driftFindingIds: "drift_findings",
  resultingFindingIds: "drift_findings", ruleVersionIds: "rule_versions",
};

function assertReferences(documents: SeedDocument[]): void {
  const keys = new Set(documents.map(([collection, id]) => `${collection}/${id}`));
  const missing: string[] = [];
  assert.equal(keys.size, documents.length, "fixture keys must be unique");
  for (const [collection, id, data] of documents) {
    assert.equal(data.id, id, `${collection}/${id} must preserve its document ID`);
    for (const [field, target] of Object.entries(scalarReferences)) {
      const value = data[field];
      if (value == null) continue;
      assert.equal(typeof value, "string", `${id}.${field} must be a string`);
      if (!keys.has(`${target}/${value}`)) missing.push(`${collection}/${id}.${field} -> ${target}/${value}`);
    }
    for (const [field, target] of Object.entries(arrayReferences)) {
      const values = data[field];
      if (values === undefined) continue;
      assert.ok(Array.isArray(values), `${id}.${field} must be an array`);
      for (const value of values) {
        assert.equal(typeof value, "string", `${id}.${field} entries must be strings`);
        if (!keys.has(`${target}/${value}`)) missing.push(`${collection}/${id}.${field} -> ${target}/${value}`);
      }
    }
  }
  assert.deepEqual(missing, [], `dangling fixture references:\n${missing.join("\n")}`);
}

for (const stage of stages) {
  test(`seed stage ${stage}: actual fixtures have no dangling references`, () => {
    assertReferences(filterSeedDocuments(buildDemoSeedDocuments(at), stage));
  });
}

test("seed stage 4: accepted findings have evidence but no proposal links", () => {
  const documents = filterSeedDocuments(buildDemoSeedDocuments(at), 4);
  const accepted = documents.filter(([collection, , data]) => collection === "drift_findings" && data.status === "accepted");
  assert.ok(accepted.length > 0, "stage 4 must demonstrate an accepted finding");
  for (const [, id, data] of accepted) {
    assert.equal(data.proposalVersionId, null, `${id} must not expose a proposal link`);
    assert.ok(Array.isArray(data.evidenceIds) && data.evidenceIds.length > 0);
    for (const evidenceId of data.evidenceIds) {
      const evidence = documents.find(([collection, candidateId]) => collection === "evidence" && candidateId === evidenceId)?.[2];
      assert.ok(evidence, `${id} must have readable evidence`);
      assert.equal(evidence.driftFindingId, id);
      assert.equal(evidence.ruleVersionId, null, "finding evidence must not depend on a future proposal");
    }
  }
  assert.ok(!documents.some(([, id]) => id === "seed-rule_versions-1"));
  assert.ok(!documents.some(([, id]) => id === "seed-analysis_jobs-7"));
});

test("seed stage 5: proposal fixture and its evidence are linked in both directions", () => {
  const documents = filterSeedDocuments(buildDemoSeedDocuments(at), 5);
  const finding = documents.find(([, id]) => id === "seed-drift_findings-5")?.[2];
  const version = documents.find(([, id]) => id === "seed-rule_versions-1")?.[2];
  assert.ok(finding && version);
  assert.equal(finding.proposalVersionId, version.id);
  assert.equal(version.status, "proposed");
  assert.deepEqual(version.driftFindingIds, [finding.id]);
  assert.deepEqual(version.evidenceIds, finding.evidenceIds);
  for (const evidenceId of version.evidenceIds as string[]) {
    const evidence = documents.find(([, id]) => id === evidenceId)?.[2];
    assert.ok(evidence);
    assert.equal(evidence.ruleVersionId, version.id);
    assert.equal(evidence.driftFindingId, finding.id);
  }
  const acceptedWithoutProposal = documents.find(([, id]) => id === "seed-drift_findings-accepted")?.[2];
  assert.ok(acceptedWithoutProposal, "stage 4 fixture remains a separate record");
  assert.equal(acceptedWithoutProposal.proposalVersionId, null);
});

test("seed stage 6: organization rules and their versions are introduced together", () => {
  const documents = buildDemoSeedDocuments(at);
  const ids = ["seed-rules-4", "seed-rules-5", "seed-rule_versions-4", "seed-rule_versions-5"];
  for (const stage of stages.filter((value) => value < 6)) {
    assert.ok(!filterSeedDocuments(documents, stage).some(([, id]) => ids.includes(id)), `unexpected organization fixture in stage ${stage}`);
  }
  const stageSix = filterSeedDocuments(documents, 6);
  assert.ok(ids.every((id) => stageSix.some(([, candidateId]) => candidateId === id)));
});

test("seed stages are cumulative and filtering does not change fixture data", () => {
  const documents = buildDemoSeedDocuments(at), original = structuredClone(documents);
  for (const stage of stages.slice(1)) {
    const previous = filterSeedDocuments(documents, (stage - 1) as DemoStage);
    const next = new Map(filterSeedDocuments(documents, stage).map(([collection, id, data]) => [`${collection}/${id}`, data]));
    for (const [collection, id, data] of previous) assert.deepEqual(next.get(`${collection}/${id}`), data);
  }
  assert.deepEqual(documents, original);
  assert.deepEqual(filterSeedDocuments(documents, 7), documents);
  assert.deepEqual(filterSeedDocuments(documents), documents);
});

test("seed fixture builder uses a fixed clock and returns isolated data", () => {
  const first = buildDemoSeedDocuments(at), second = buildDemoSeedDocuments(at);
  assert.deepEqual(first, second);
  first[0][2].login = "changed";
  assert.notDeepEqual(first, second);
  assert.equal(second[0][2].createdAt, at.toISOString());
  const invitation = second.find(([collection]) => collection === "workspace_invitations")?.[2];
  assert.equal(invitation?.expiresAt, "2026-01-08T00:00:00.000Z");
});

test("seed stage arguments accept 1 through 7 and reject malformed or duplicate values", () => {
  assert.equal(parseSeedStage([]), undefined);
  for (const stage of stages) assert.equal(parseSeedStage([`--stage=${stage}`]), stage);
  for (const args of [["--stage=0"], ["--stage=8"], ["--stage=4.0"], ["--stage="], ["--stage=4", "--stage=5"]]) {
    assert.throws(() => parseSeedStage(args), /--stage/);
  }
});

for (const [label, host, mode, message] of [
  ["missing emulator", "", "development", "FIRESTORE_EMULATOR_HOST is required"],
  ["production", "127.0.0.1:8080", "production", "seed-demo must not run in production"],
] as const) {
  test(`seed CLI rejects ${label} before connecting to Firestore`, () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scripts/seed-demo.ts", import.meta.url))], {
      env: { ...process.env, FIRESTORE_EMULATOR_HOST: host, NODE_ENV: mode },
      encoding: "utf8", timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(message), result.stderr);
  });
}
