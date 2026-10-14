import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../src/shared/auth.ts";
import type { GitHubAppApiClient, GitHubRepository } from "../src/shared/github-app.ts";
import { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";
import { createPurgeHandlers } from "../src/shared/purge-api.ts";

class FakeGitHub implements Pick<GitHubAppApiClient, "listInstallationRepositories"> {
  repositories: GitHubRepository[] = [{ id: "100", name: "api", full_name: "acme/api", default_branch: "trunk", owner: { login: "acme" } }];
  async listInstallationRepositories(_id: string) { return this.repositories; }
}
const documents = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((doc) => doc.data()!);
async function fixture() {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), github = new FakeGitHub(), auth = new AuthService(store, { exchangeCodeForToken: async () => "token", getAuthenticatedUser: async () => ({ id: "1", login: "owner" }) });
  const user = await auth.loginGitHubUser({ id: "1", login: "owner" }), workspaceId = user.personalWorkspaceId as string;
  await store.runTransaction(async (tx) => { tx.create(store.documentRef("installations", "install-1"), { id: "install-1", ownerWorkspaceId: workspaceId, githubInstallationId: "900", repositorySelection: "selected", status: "active" }); });
  return { db, store, github, service: new ProjectRepositoryService(store, github), user, workspaceId };
}
async function strictFixture() {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), store = new FirestoreRuleStore(db), github = new FakeGitHub();
  db.put("users/user", { id: "user", personalWorkspaceId: "workspace" });
  db.put("workspace_members/member", { id: "member", workspaceId: "workspace", userId: "user", role: "owner" });
  db.put("unique_keys/workspace_member:workspace:user", { id: "workspace_member:workspace:user", ownerWorkspaceId: "workspace", targetId: "member" });
  db.put("installations/install-1", { id: "install-1", ownerWorkspaceId: "workspace", githubInstallationId: "900", repositorySelection: "selected", status: "active" });
  return { db, service: new ProjectRepositoryService(store, github) };
}
const projectInput = { name: "API", slug: "api", repositoryGithubIds: ["100"] };

test("project creation atomically links selected repositories and enqueues one bootstrap after commit", async () => {
  const f = await fixture(), project = await f.service.createProject(f.workspaceId, f.user.id, projectInput);
  const repositories = documents(f.db, "repositories"), jobs = documents(f.db, "analysis_jobs");
  assert.equal(repositories.length, 1); assert.deepEqual({ provider: repositories[0]!.provider, defaultBranch: repositories[0]!.defaultBranch, rulesPath: repositories[0]!.rulesPath, compileTargets: repositories[0]!.compileTargets }, { provider: "github", defaultBranch: "trunk", rulesPath: ".rulebranch/", compileTargets: ["agents-md", "claude-md", "copilot-instructions", "rulebranch-rules"] });
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.idempotencyKey, `bootstrap:${project.id}`); assert.equal(documents(f.db, "audit_logs").some((entry) => entry.action === "project.create"), true); assert.equal(documents(f.db, "audit_logs").some((entry) => entry.action === "repository.link"), true);
});
test("project creation keeps all Firestore transaction reads ahead of writes", async () => {
  const f = await strictFixture();
  const project = await f.service.createProject("workspace", "user", projectInput);
  assert.equal(project.slug, "api");
  assert.equal(documents(f.db, "repositories").length, 1);
});

test("unselected repositories and oversized metadata arrays are rejected", async () => {
  const f = await fixture();
  await assert.rejects(f.service.createProject(f.workspaceId, f.user.id, { ...projectInput, repositoryGithubIds: ["404"] }), (error: RuleStoreError) => error.status === 422);
  await assert.rejects(f.service.createProject(f.workspaceId, f.user.id, { ...projectInput, primaryLanguages: Array(21).fill("ts") }), (error: RuleStoreError) => error.status === 422);
  await assert.rejects(f.service.createProject(f.workspaceId, f.user.id, { ...projectInput, frameworks: Array(21).fill("next") }), (error: RuleStoreError) => error.status === 422);
  await assert.rejects(f.service.createProject(f.workspaceId, f.user.id, { ...projectInput, focusThemes: Array(11).fill("quality") }), (error: RuleStoreError) => error.status === 422);
});

test("project slug is unique and concurrent duplicate requests leave one bootstrap job", async () => {
  const f = await fixture(); const results = await Promise.allSettled([f.service.createProject(f.workspaceId, f.user.id, projectInput), f.service.createProject(f.workspaceId, f.user.id, projectInput)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult; assert.equal((rejected.reason as RuleStoreError).code, "UNIQUE_VIOLATION"); assert.equal(documents(f.db, "analysis_jobs").length, 1);
});

test("removed repositories are restored in place, while non-github providers are rejected", async () => {
  const f = await fixture(), project = await f.service.createProject(f.workspaceId, f.user.id, projectInput), repository = documents(f.db, "repositories")[0]!;
  await f.service.unlinkRepository(f.workspaceId, f.user.id, repository.id as string); const restored = await f.service.addRepository(f.workspaceId, f.user.id, { projectId: project.id as string, githubRepoId: "100" });
  assert.equal(restored.id, repository.id); assert.equal(restored.status, "active"); assert.equal(documents(f.db, "repositories").length, 1);
  await assert.rejects(f.service.addRepository(f.workspaceId, f.user.id, { projectId: project.id as string, githubRepoId: "100", provider: "gitlab" as never }), (error: RuleStoreError) => error.status === 422);
});

test("unlink revokes a live compile lease so worker checkpoints cannot publish afterward", async () => {
  const f = await fixture();
  await f.service.createProject(f.workspaceId, f.user.id, projectInput);
  const repo = documents(f.db, "repositories")[0]!;
  const lease = { owner: "running", expiresAt: "2099-01-01T00:00:00Z" };
  f.db.put(`repositories/${repo.id}`, { ...repo, compileLease: lease });
  const removed = await f.service.unlinkRepository(f.workspaceId, f.user.id, String(repo.id));
  assert.equal(removed.status, "removed");
  assert.equal(removed.compileLease, null);
  assert.equal((await f.store.get({ workspaceId: f.workspaceId, actorUserId: f.user.id }, "repositories", String(repo.id)))?.status, undefined);
  assert.equal(documents(f.db, "repositories")[0]!.compileLease, null);
});

test("project bootstrap intent survives failure before job persistence and is recovered by scheduler", async () => {
  const f = await fixture();
  const createJob = f.store.createAnalysisJob.bind(f.store);
  f.store.createAnalysisJob = async () => { throw new Error("injected failure before job persistence"); };
  await assert.rejects(f.service.createProject(f.workspaceId, f.user.id, projectInput), /injected failure/);
  const project = documents(f.db, "projects")[0]!;
  assert.equal(project.bootstrapPending, true);
  assert.equal(documents(f.db, "analysis_jobs").length, 0);
  f.store.createAnalysisJob = createJob;
  const handlers = createPurgeHandlers(f.store, { verify: () => true }, "scheduler-audience", "secret");
  const request = new Request("https://example.invalid/jobs-reconcile", { method: "POST", headers: { Authorization: "Bearer scheduler-token" } });
  assert.equal((await handlers.reconcileJobs(request, async () => {})).status, 200);
  const jobs = documents(f.db, "analysis_jobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.idempotencyKey, `bootstrap:${project.id}`);
  assert.equal(documents(f.db, "projects")[0]!.bootstrapPending, false);
  await handlers.reconcileJobs(request, async () => {});
  assert.equal(documents(f.db, "analysis_jobs").length, 1);
});
