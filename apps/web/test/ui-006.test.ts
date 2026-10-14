import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { createEvidenceHandlers } from "../src/shared/http-api.ts";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "ui-006-secret", workspaceId = "workspace-ui-006", userId = "user-ui-006";
async function setup() {
  const store = new FirestoreRuleStore(new InMemoryFirestore());
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspaces", workspaceId), { id: workspaceId, kind: "organization" });
    tx.create(store.documentRef("workspace_members", "member-ui-006"), { id: "member-ui-006", workspaceId, userId, role: "admin" });
    tx.create(store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`), { id: `workspace_member:${workspaceId}:${userId}`, targetId: "member-ui-006" });
    tx.create(store.documentRef("evidence", "evidence-own"), { id: "evidence-own", ownerWorkspaceId: workspaceId, scopeType: "organization", scopeId: workspaceId });
    tx.create(store.documentRef("evidence", "evidence-other"), { id: "evidence-other", ownerWorkspaceId: "other-workspace" });
  });
  return store;
}
const request = (url: string, authenticated = true) => new Request(url, { headers: authenticated ? { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}` } : {} });

test("UI-006 evidence endpoint authenticates, limits ids, and tenant-filters missing or foreign evidence", async () => {
  const store = await setup(), handler = createEvidenceHandlers(store, secret);
  assert.equal((await handler.list(request("http://test/api/evidence?workspaceId=workspace-ui-006&ids=evidence-own", false))).status, 401);
  const tooMany = Array.from({ length: 21 }, (_, i) => `e${i}`).join(",");
  assert.equal((await handler.list(request(`http://test/api/evidence?workspaceId=workspace-ui-006&ids=${tooMany}`))).status, 422);
  const response = await handler.list(request("http://test/api/evidence?workspaceId=workspace-ui-006&ids=evidence-own,evidence-other,missing"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { evidence: Array<{ id: string }> }).evidence.map((item) => item.id), ["evidence-own"]);
});

test("UI-006 lifecycle transitions active to deprecated, archived, then restored", async () => {
  const store = await setup(), service = new RulesService(store), ruleId = "rule-ui-006", versionId = "version-ui-006";
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("projects", "project"), { id: "project", ownerWorkspaceId: workspaceId, status: "active", deletedAt: null });
    tx.create(store.documentRef("rules", ruleId), { id: ruleId, ownerWorkspaceId: workspaceId, projectId: "project", scopeType: "project", scopeId: "project", enforcement: "advisory", status: "active", currentVersionId: "old", nextVersion: 2 });
    tx.create(store.documentRef("rule_versions", versionId), { id: versionId, ownerWorkspaceId: workspaceId, ruleId, version: 2, status: "proposed", content: "restore", rationale: "restore", evidenceIds: [], driftFindingIds: [], changeType: "clarify", provenance: { sourceType: "human" } });
  });
  await service.updateRuleStatus(workspaceId, userId, ruleId, "deprecated", { rationale: "obsolete" });
  assert.equal((await service.getRule(workspaceId, userId, ruleId)).status, "deprecated");
  await service.updateRuleStatus(workspaceId, userId, ruleId, "archived");
  assert.equal((await service.getRule(workspaceId, userId, ruleId)).status, "archived");
  await service.updateRuleStatus(workspaceId, userId, ruleId, "active", { approvedVersionId: versionId });
  const restored = await service.getRule(workspaceId, userId, ruleId);
  assert.equal(restored.status, "active");
  assert.equal(restored.currentVersionId, versionId);
});
