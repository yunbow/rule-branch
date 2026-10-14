import assert from "node:assert/strict";
import test from "node:test";
import { ruleMetadataError, ruleMetadataPatch, ruleMetadataValues } from "../src/lib/rule-metadata-form.ts";
import { signSession } from "../src/shared/auth.ts";
import { createRuleHandlers } from "../src/shared/http-api.ts";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

test("editing existing metadata preserves dependency names and absent optional fields have safe defaults", () => {
  const values = ruleMetadataValues({ title: "Security", maintenance: { watchDependencies: ["react", "next"] }, ownerUserId: "existing-owner" });
  assert.deepEqual(values.watchDependencies, ["react", "next"]);
  assert.equal(values.ownerUserId, "existing-owner");
  assert.deepEqual(values.tags, []);
  assert.deepEqual(values.selector.repositoryIds, []);
  assert.deepEqual(ruleMetadataPatch(ruleMetadataValues({ title: "Security" })).maintenance, { watchDependencies: [] });
});

test("metadata form blocks empty titles, empty specific repository selection, and API limit violations", () => {
  const values = ruleMetadataValues({ title: "Security" });
  assert.equal(ruleMetadataError(values, "all"), null);
  assert.match(ruleMetadataError({ ...values, title: " \n " }, "all") ?? "", /タイトル/);
  assert.match(ruleMetadataError(values, "specific") ?? "", /リポジトリ/);
  assert.match(ruleMetadataError({ ...values, tags: Array(21).fill("tag") }, "all") ?? "", /20件/);
  assert.match(ruleMetadataError({ ...values, watchDependencies: Array(51).fill("react") }, "all") ?? "", /50件/);
  assert.match(ruleMetadataError({ ...values, selector: { ...values.selector, languages: Array(21).fill("TS") } }, "all") ?? "", /20件/);
});

test("metadata form PATCH succeeds without changing existing maintenance settings, versions, or identity", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new RulesService(store);
  db.put("workspaces/ws", { id: "ws", kind: "organization" });
  db.put("unique_keys/workspace_member:ws:member", { targetId: "membership" });
  db.put("workspace_members/membership", { workspaceId: "ws", userId: "member", role: "member" });
  db.put("projects/project", { id: "project", ownerWorkspaceId: "ws", status: "active", deletedAt: null });
  const original = { id: "rule", ownerWorkspaceId: "ws", title: "Original", scopeType: "project", projectId: "project", key: "security", status: "active", currentVersionId: "v2", nextVersion: 3, ownerUserId: "previous-owner", maintenance: { watchDependencies: ["react"], reviewIntervalDays: 30, expiresAt: "2027-01-01T00:00:00Z" } };
  db.put("rules/rule", original);
  const values = ruleMetadataValues(original);
  const patch = ruleMetadataPatch({ ...values, title: " Updated ", watchDependencies: ["react", "next"] });
  const handler = createRuleHandlers(service, "isolated-secret");
  const response = await handler.patch(new Request("https://local/api/rules/rule", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Requested-With": "RuleBranch", cookie: `rulebranch_session=${signSession({ userId: "member", issuedAt: Date.now() }, "isolated-secret")}` },
    body: JSON.stringify({ ownerWorkspaceId: "ws", ...patch }),
  }), "rule");
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.title, "Updated");
  assert.deepEqual(updated.maintenance, { ...original.maintenance, watchDependencies: ["react", "next"] });
  for (const field of ["key", "scopeType", "projectId", "status", "currentVersionId", "nextVersion", "ownerUserId"] as const) assert.equal(updated[field], original[field]);
  assert.equal(db.query("rule_versions", []).length, 0);
  assert.equal(db.query("audit_logs", [])[0]!.data()!.action, "rule.metadata_update");
  assert.equal((await handler.patch(new Request("https://local/api/rules/rule", {
    method: "PATCH", headers: { "X-Requested-With": "RuleBranch" }, body: JSON.stringify({ ownerWorkspaceId: "ws", ...patch }),
  }), "rule")).status, 401);
});
