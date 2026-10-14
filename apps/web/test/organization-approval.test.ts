import assert from "node:assert/strict";
import test from "node:test";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";
import { canApproveRuleVersion, type WorkspaceRole } from "../src/shared/permissions.ts";

for (const enforcement of ["default", "advisory", "locked"] as const) {
  test(`organization ${enforcement} approval permits admins and owners only`, async () => {
    for (const role of ["owner", "admin", "maintainer", "member", "viewer"] as WorkspaceRole[]) {
      const expected = role === "owner" || role === "admin";
      assert.equal(canApproveRuleVersion({ workspaceKind: "organization", scopeType: "organization", enforcement }, role), expected);
      const db = new InMemoryFirestore();
      db.put("workspaces/w", { id: "w", kind: "organization" });
      db.put("unique_keys/workspace_member:w:user", { targetId: "m" });
      db.put("workspace_members/m", { role, ownerWorkspaceId: "w" });
      db.put("rules/r", { id: "r", ownerWorkspaceId: "w", scopeType: "organization", scopeId: "w", enforcement, status: "draft", title: "Org", key: "org", layer: "L3" });
      db.put("rule_versions/v", { id: "v", ownerWorkspaceId: "w", ruleId: "r", status: "proposed", version: 1, content: "Rules", rationale: "Reason", provenance: { sourceType: "human" }, evidenceIds: [] });
      const service = new RulesService(new FirestoreRuleStore(db));
      if (expected) {
        const approved = await service.approveRuleVersion("w", "user", "v");
        assert.equal(approved.status, "approved");
        assert.equal((await service.getRule("w", "user", "r")).currentVersionId, "v");
        assert.equal(db.query("decision_memories", []).length, 1);
      } else await assert.rejects(service.approveRuleVersion("w", "user", "v"), (error: RuleStoreError) => error.code === "FORBIDDEN");
    }
  });
}

test("member cannot disable an approved organization rule or widen its scope", async () => {
  for (const role of ["member", "maintainer", "admin"] as WorkspaceRole[]) {
    const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
    db.put("workspaces/w", { id: "w", kind: "organization" });
    db.put("unique_keys/workspace_member:w:user", { targetId: "membership" });
    db.put("workspace_members/membership", { role, ownerWorkspaceId: "w" });
    db.put("rules/r", {
      id: "r", ownerWorkspaceId: "w", scopeType: "organization", scopeId: "w",
      enforcement: "locked", status: "active", currentVersionId: "v", selector: { languages: ["TypeScript"] }
    });
    const service = new RulesService(store);
    if (role === "admin") {
      await service.updateRuleMetadata("w", "user", "r", { selector: { languages: ["Python"] } });
      assert.deepEqual((await store.get({ workspaceId: "w", actorUserId: "user" }, "rules", "r"))?.selector,
        { languages: ["Python"], frameworks: [], directoryGlobs: [], dependencies: [], repositoryIds: [] });
      assert.equal((await service.updateRuleStatus("w", "user", "r", "deprecated", { rationale: "obsolete" })).status, "deprecated");
    } else {
      await assert.rejects(service.updateRuleMetadata("w", "user", "r", { selector: { languages: ["Python"] } }),
        (error: RuleStoreError) => error.code === "FORBIDDEN");
      await assert.rejects(service.updateRuleStatus("w", "user", "r", "deprecated", { rationale: "obsolete" }),
        (error: RuleStoreError) => error.code === "FORBIDDEN");
      assert.equal((await service.updateRuleMetadata("w", "user", "r", { title: "Non-semantic title" })).title, "Non-semantic title");
    }
  }
});

test("relation which can deny an organization policy requires its approval authority", async () => {
  for (const role of ["member", "maintainer", "admin"] as WorkspaceRole[]) {
    const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
    db.put("workspaces/w", { id: "w", kind: "organization" });
    db.put("unique_keys/workspace_member:w:user", { targetId: "membership" });
    db.put("workspace_members/membership", { role, ownerWorkspaceId: "w" });
    db.put("projects/project", { id: "project", ownerWorkspaceId: "w", status: "active" });
    db.put("rules/parent", { id: "parent", ownerWorkspaceId: "w", scopeType: "organization", scopeId: "w", status: "active", enforcement: "default" });
    db.put("rules/child", { id: "child", ownerWorkspaceId: "w", scopeType: "project", scopeId: "project", projectId: "project", status: "active", enforcement: "default" });
    const service = new RulesService(store);
    if (role === "admin") {
      const rel = await service.createRelation("w", "user", { childRuleId: "child", parentRuleId: "parent", relationType: "deny", rationale: "explicit exception" });
      assert.equal(rel.relationType, "deny");
    } else {
      await assert.rejects(service.createRelation("w", "user", { childRuleId: "child", parentRuleId: "parent", relationType: "deny", rationale: "unreviewed" }),
        (error: RuleStoreError) => error.code === "FORBIDDEN");
      assert.equal(db.query("rule_relations", []).length, 0);
    }
  }
});
