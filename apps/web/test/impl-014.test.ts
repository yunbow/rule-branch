import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { createProjectRepositoryHandlers } from "../src/shared/http-api.ts";
import { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "impl-014-test-secret";
const docs = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((value) => value.data()!);
const request = (url: string, userId: string, body?: Record<string, unknown>) => new Request(url, { method: body ? "POST" : "GET", headers: { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}`, ...(body ? { "content-type": "application/json", "x-requested-with": "RuleBranch" } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), workspace = "ws-014", otherWorkspace = "ws-other-014";
  await store.runTransaction(async (tx) => {
    for (const [id, ownerWorkspaceId] of [["owner-014", workspace], ["maintainer-014", workspace], ["member-014", workspace], ["viewer-014", workspace]] as const) { tx.create(store.documentRef("unique_keys", `workspace_member:${ownerWorkspaceId}:${id}`), { targetId: `membership-${id}`, ownerWorkspaceId }); tx.create(store.documentRef("workspace_members", `membership-${id}`), { ownerWorkspaceId, role: id.split("-")[0] }); }
    for (const id of ["project-a", "project-b"]) tx.create(store.documentRef("projects", id), { id, ownerWorkspaceId: workspace, status: "active", deletedAt: null });
    tx.create(store.documentRef("projects", "project-other"), { id: "project-other", ownerWorkspaceId: otherWorkspace, status: "active", deletedAt: null });
    for (const value of [{ id: "repo-org-a", ownerWorkspaceId: workspace, projectId: "project-a", status: "active" }, { id: "repo-org-b", ownerWorkspaceId: workspace, projectId: "project-b", status: "active" }, { id: "repo-removed", ownerWorkspaceId: workspace, projectId: "project-a", status: "removed" }, { id: "repo-other", ownerWorkspaceId: otherWorkspace, projectId: "project-other", status: "active" }]) tx.create(store.documentRef("repositories", value.id), value);
  });
  const service = new ProjectRepositoryService(store, { listInstallationRepositories: async () => [] }), handlers = createProjectRepositoryHandlers(service, secret);
  return { db, store, workspace, otherWorkspace, service, handlers };
}

test("approval hook fans organization rules out to active repositories and honors project repository selectors", async () => {
  const f = await fixture(), ctx = { workspaceId: f.workspace, actorUserId: "owner-014", actorKind: "user" as const };
  await f.store.runTransaction(async (tx) => {
    tx.create(f.store.documentRef("rules", "org-rule"), { id: "org-rule", ownerWorkspaceId: f.workspace, scopeType: "organization", selector: {} }); tx.create(f.store.documentRef("rule_versions", "org-v"), { id: "org-v", ownerWorkspaceId: f.workspace, ruleId: "org-rule" });
  });
  await f.store.onRuleVersionApproved("org-v", ctx);
  assert.deepEqual(docs(f.db, "analysis_jobs").map((job) => job.idempotencyKey).sort(), ["compile:repo-org-a:org-v", "compile:repo-org-b:org-v"]);
  await f.store.runTransaction(async (tx) => { tx.create(f.store.documentRef("rules", "project-rule"), { id: "project-rule", ownerWorkspaceId: f.workspace, scopeType: "project", projectId: "project-a", selector: { repositoryIds: ["repo-org-a"] } }); tx.create(f.store.documentRef("rule_versions", "project-v"), { id: "project-v", ownerWorkspaceId: f.workspace, ruleId: "project-rule" }); });
  await f.store.onRuleVersionApproved("project-v", ctx);
  const keys = docs(f.db, "analysis_jobs").map((job) => job.idempotencyKey); assert.ok(keys.includes("compile:repo-org-a:project-v")); assert.ok(!keys.includes("compile:repo-org-b:project-v"));
});

test("manual recompile requires maintainer, returns 202, and audits its idempotent job", async () => {
  const f = await fixture();
  for (const userId of ["member-014", "viewer-014"]) { const response = await f.handlers.recompile(request("https://test/repositories/repo-org-a", userId, { ownerWorkspaceId: f.workspace, requestId: `denied-${userId}` }), "repo-org-a"); assert.equal(response.status, 403); }
  const response = await f.handlers.recompile(request("https://test/repositories/repo-org-a", "maintainer-014", { ownerWorkspaceId: f.workspace, requestId: "manual-1" }), "repo-org-a"); const body = await response.json() as { jobId: string };
  assert.equal(response.status, 202); assert.ok(body.jobId); const job = docs(f.db, "analysis_jobs").find((value) => value.id === body.jobId)!; assert.equal(job.idempotencyKey, "compile:repo-org-a:manual-1"); assert.ok(docs(f.db, "audit_logs").some((value) => value.action === "repository.recompile"));
});

test("revision PR and artifact listing are tenant-isolated", async () => {
  const f = await fixture();
  await f.store.runTransaction(async (tx) => { tx.create(f.store.documentRef("revision_prs", "our-pr"), { id: "our-pr", ownerWorkspaceId: f.workspace, repositoryId: "repo-org-a" }); tx.create(f.store.documentRef("revision_prs", "other-pr"), { id: "other-pr", ownerWorkspaceId: f.otherWorkspace, repositoryId: "repo-other" }); tx.create(f.store.documentRef("compiled_artifacts", "our-artifact"), { id: "our-artifact", ownerWorkspaceId: f.workspace, repositoryId: "repo-org-a" }); tx.create(f.store.documentRef("compiled_artifacts", "other-artifact"), { id: "other-artifact", ownerWorkspaceId: f.otherWorkspace, repositoryId: "repo-other" }); });
  const revision = await f.handlers.revisionPrs(request(`https://test/revision-prs?workspaceId=${f.workspace}`, "viewer-014")); const artifacts = await f.handlers.compiledArtifacts(request(`https://test/compiled-artifacts?workspaceId=${f.workspace}`, "viewer-014"));
  assert.deepEqual((await revision.json() as { revisionPrs: { id: string }[] }).revisionPrs.map((value) => value.id), ["our-pr"]); assert.deepEqual((await artifacts.json() as { compiledArtifacts: { id: string }[] }).compiledArtifacts.map((value) => value.id), ["our-artifact"]);
});
