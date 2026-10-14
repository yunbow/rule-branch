import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENUMS, LIMITS } from "../src/shared/contracts.ts";
import { loadConfig } from "../src/shared/config.ts";
import { ERROR_CODES } from "../src/shared/errors.ts";
import { generateUlid } from "../src/shared/ulid.ts";
import { auditActor, userActor, userContext } from "../src/shared/service-context.ts";

const root = resolve(import.meta.dirname, "../../..");
test("enum catalog is an exact parity copy of the shared contract", () => assert.deepEqual(ENUMS, JSON.parse(readFileSync(resolve(root, "contracts/enums.json"), "utf8"))));
test("limits loader is an exact parity copy of the shared contract", () => assert.deepEqual(LIMITS, JSON.parse(readFileSync(resolve(root, "contracts/limits.json"), "utf8"))));
test("config permits only cloud-saas and resolves models from configuration", () => {
  assert.throws(() => loadConfig({ RULEBRANCH_DEPLOYMENT_MODE: "hybrid-local" }));
  const config = loadConfig({ RULEBRANCH_AI_PROVIDER: "gemini-api", RULEBRANCH_AI_MODEL_FAST: "configured-fast", RULEBRANCH_AI_MODEL_REASONING: "configured-reasoning" });
  assert.equal(config.ai.model.fast, "configured-fast"); assert.equal(config.deployment.mode, "cloud-saas");
});
test("ULIDs are unique, lexicographically time-sortable, and 26 characters", () => { const first = generateUlid(1); const later = generateUlid(2); assert.equal(first.length, 26); assert.ok(first < later); assert.notEqual(generateUlid(5), generateUlid(5)); });
test("error catalog contains the 16 ticket codes", () => assert.equal(ERROR_CODES.length, 16));
test("service contexts keep user and non-user audit identities canonical", () => {
  assert.deepEqual(userContext("workspace-1", "user-1"), { workspaceId: "workspace-1", actorUserId: "user-1", actorKind: "user" });
  assert.deepEqual(userActor("user-1"), { kind: "user", id: "user-1" });
  assert.deepEqual(auditActor({ workspaceId: "workspace-1", actorUserId: "user-1" }), { kind: "user", id: "user-1" });
  assert.deepEqual(auditActor({ workspaceId: "workspace-1", actorUserId: null, actorKind: "system" }), { kind: "system", id: "system" });
});
test("Firestore rules deny all client access and required indexes contain no arrays", () => {
  const rules = readFileSync(resolve(root, "firestore.rules"), "utf8");
  assert.match(rules, /allow read, write: if false;/);
  const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8")).indexes;
  const required = [
    ["rules", ["ownerWorkspaceId", "status"]], ["rules", ["ownerWorkspaceId", "projectId", "status"]],
    ["rule_versions", ["ownerWorkspaceId", "ruleId", "version"]], ["usage_provenance", ["ownerWorkspaceId", "ruleVersionId", "recordedAt"]],
    ["drift_findings", ["ownerWorkspaceId", "status", "severity"]], ["audit_logs", ["ownerWorkspaceId", "occurredAt"]],
    ["resolution_snapshots", ["ownerWorkspaceId", "projectId", "repositoryId", "resolvedAt"]], ["revision_prs", ["ownerWorkspaceId", "repositoryId", "status", "mergedAt"]],
  ];
  for (const [collection, fields] of required) assert.ok(indexes.some((index: { collectionGroup: string; fields: { fieldPath: string; arrayConfig?: string }[] }) => index.collectionGroup === collection && JSON.stringify(index.fields.map((field) => field.fieldPath)) === JSON.stringify(fields)));
  assert.ok(indexes.every((index: { fields: { arrayConfig?: string }[] }) => index.fields.every((field) => field.arrayConfig === undefined)));
});
