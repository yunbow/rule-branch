import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

test("human approval records the exact approved version and its decision fields atomically", async () => {
  const db = new InMemoryFirestore();
  const store = new FirestoreRuleStore(db);
  const put = (collection: string, id: string, data: Record<string, unknown>) =>
    db.put(`${collection}/${id}`, { id, ownerWorkspaceId: "w", ...data });
  put("projects", "p", { status: "active", deletedAt: null });
  put("rules", "rule", {
    projectId: "p", scopeType: "project", scopeId: "p", title: "Naming",
    status: "draft", visibility: "private", enforcement: "advisory",
    transferPolicy: "project-only", licenseType: "proprietary-customer",
    provenance: { sourceType: "human" },
  });
  put("rule_versions", "version", {
    ruleId: "rule", version: 2, status: "proposed", rationale: "Use PascalCase",
    changeType: "clarify", evidenceIds: [],
  });
  await store.approveRuleVersion(
    { workspaceId: "w", actorUserId: "u" }, "version",
    { comment: "Reviewed by maintainer", requestId: "decision-memory-v2" },
  );
  const saved = db.query("decision_memories", []).map((doc) => doc.data()!);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.projectId, "p");
  assert.deepEqual(saved[0]!.linkedRuleIds, ["rule"]);
  assert.equal(saved[0]!.approvedRuleVersionId, "version");
  assert.equal(saved[0]!.approvedRuleVersionNumber, 2);
  assert.equal(saved[0]!.approvedChangeType, "clarify");
  assert.equal(saved[0]!.approvalComment, "Reviewed by maintainer");
  assert.equal(saved[0]!.approvalMode, "human");
  assert.equal(saved[0]!.decision, "Use PascalCase");
  assert.equal(db.query("rule_versions", []).find((doc) => doc.id === "version")!.data()!.status, "approved");
});
