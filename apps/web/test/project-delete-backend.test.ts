import assert from "node:assert/strict";
import test from "node:test";
import { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import { FirestoreRuleStore, RuleStoreError, uniqueKeyId } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const workspaceId = "workspace-a", projectId = "project-a", userId = "owner-a";
function fixture() {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), store = new FirestoreRuleStore(db);
  db.put(`workspaces/${workspaceId}`, { id: workspaceId, ownerWorkspaceId: workspaceId, status: "active" });
  db.put("workspace_members/member-a", { id: "member-a", ownerWorkspaceId: workspaceId, workspaceId, userId, role: "owner" });
  db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, { id: `workspace_member:${workspaceId}:${userId}`, ownerWorkspaceId: workspaceId, targetTable: "workspace_members", targetId: "member-a" });
  db.put(`projects/${projectId}`, { id: projectId, ownerWorkspaceId: workspaceId, name: "Alpha", slug: "alpha", status: "active", deletedAt: null });
  const slugKey = uniqueKeyId("project_slug", { ownerWorkspaceId: workspaceId, slug: "alpha" });
  db.put(`unique_keys/${slugKey}`, { id: slugKey, kind: "project_slug", ownerWorkspaceId: workspaceId, targetTable: "projects", targetId: projectId });
  db.put("repositories/repo-a", { id: "repo-a", ownerWorkspaceId: workspaceId, projectId, githubRepoId: "10", status: "active", deletedAt: null });
  db.put("unique_keys/github_repo:10", { id: "github_repo:10", kind: "github_repo", ownerWorkspaceId: null, targetTable: "repositories", targetId: "repo-a" });
  return { db, store, service: new ProjectRepositoryService(store, { listInstallationRepositories: async () => [] }) };
}

test("project deletion atomically tombstones project and repositories, frees its slug, and retains audit", async () => {
  const f = fixture();
  const result = await f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" });
  assert.equal(result.status, "archived"); assert.ok(result.deletedAt);
  assert.equal(f.db.getStored("projects", projectId)?.data.status, "archived");
  assert.equal(f.db.getStored("repositories", "repo-a")?.data.status, "removed");
  assert.equal(f.db.getStored("unique_keys", uniqueKeyId("project_slug", { ownerWorkspaceId: workspaceId, slug: "alpha" })), undefined);
  assert.equal(f.db.query("audit_logs", []).some((snapshot) => snapshot.data()?.action === "project.delete"), true);
});

test("project deletion requires the exact name and rejects running work or an active compile lease", async () => {
  const f = fixture();
  await assert.rejects(f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "alpha" }), (error: RuleStoreError) => error.code === "PROJECT_NAME_MISMATCH");
  f.db.put("analysis_jobs/job-a", { id: "job-a", ownerWorkspaceId: workspaceId, projectId, type: "compile", status: "running", deletedAt: null });
  await assert.rejects(f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" }), (error: RuleStoreError) => error.code === "PROJECT_BUSY");
  f.db.put("analysis_jobs/job-a", { id: "job-a", ownerWorkspaceId: workspaceId, projectId, type: "compile", status: "done", deletedAt: null });
  f.db.put("repositories/repo-a", { id: "repo-a", ownerWorkspaceId: workspaceId, projectId, githubRepoId: "10", status: "active", deletedAt: null, compileLease: { owner: "worker", expiresAt: "2999-01-01T00:00:00.000Z" } });
  await assert.rejects(f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" }), (error: RuleStoreError) => error.code === "PROJECT_BUSY");
});

test("new jobs cannot be created for a deleted project", async () => {
  const f = fixture(); await f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" });
  await assert.rejects(f.store.createAnalysisJob({ workspaceId, actorUserId: userId }, { type: "compile", projectId, payload: { repositoryId: "repo-a" }, idempotencyKey: "compile:repo-a:request", requestId: "request" }), (error: RuleStoreError) => error.code === "PROJECT_DELETED");
});

test("a job claim after the delete query conflicts on the shared project fence and is observed on retry", async () => {
  const f = fixture(); let queried!: () => void, release!: () => void, attempts = 0;
  const querySeen = new Promise<void>((resolve) => { queried = resolve; }), resume = new Promise<void>((resolve) => { release = resolve; });
  const original = f.store.queryRef.bind(f.store);
  f.store.queryRef = ((collection: string, filter: Record<string, unknown>) => {
    const query = original(collection, filter), get = query.get.bind(query);
    if (collection !== "analysis_jobs") return query;
    return { ...query, where: query.where.bind(query), orderBy: query.orderBy.bind(query), limit: query.limit.bind(query), startAfter: query.startAfter.bind(query), get: async () => { attempts += 1; const result = await get(); if (attempts === 1) { queried(); await resume; } return result; } };
  }) as typeof f.store.queryRef;
  const deleting = f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" });
  await querySeen;
  const created = await f.store.createAnalysisJob({ workspaceId, actorUserId: userId }, { type: "compile", projectId, payload: { repositoryId: "repo-a" }, idempotencyKey: "compile:repo-a:race", requestId: "race" });
  await f.store.updateAnalysisJobStatus({ workspaceId, actorUserId: userId }, String(created.job.id), "running");
  release();
  await assert.rejects(deleting, (error: RuleStoreError) => error.code === "PROJECT_BUSY");
  assert.equal(attempts, 2); assert.equal(f.db.getStored("projects", projectId)?.data.status, "active");
});

test("recreating a deleted slug and GitHub repository preserves the old repository record", async () => {
  const f = fixture();
  f.db.put("installations/install-a", { id: "install-a", ownerWorkspaceId: workspaceId, status: "active", repositorySelection: "selected", githubInstallationId: "99" });
  await f.service.deleteProject(workspaceId, userId, projectId, { confirmName: "Alpha" });
  const service = new ProjectRepositoryService(f.store, { listInstallationRepositories: async () => [{ id: 10, name: "repo", full_name: "acme/repo", owner: { login: "acme" }, default_branch: "main" }] });
  const recreated = await service.createProject(workspaceId, userId, { name: "Alpha 2", slug: "alpha", installationId: "install-a", repositoryGithubIds: ["10"] });
  const repositories = f.db.query("repositories", []).map((snapshot) => snapshot.data()!);
  const oldRepository = repositories.find((repository) => repository.id === "repo-a")!, newRepository = repositories.find((repository) => repository.projectId === recreated.id)!;
  assert.notEqual(newRepository.id, oldRepository.id); assert.equal(oldRepository.projectId, projectId); assert.equal(oldRepository.status, "removed");
  assert.equal(f.db.getStored("unique_keys", "github_repo:10")?.data.targetId, newRepository.id);
  assert.equal((await f.store.list({ workspaceId, actorUserId: userId }, "repositories", { projectId })).length, 0);
});
