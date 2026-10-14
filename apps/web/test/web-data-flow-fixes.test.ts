import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { requireRole } from "../src/shared/authz.ts";
import { DriftService } from "../src/shared/drift.ts";
import { GitHubAppService, type GitHubAppApiClient, type GitHubPullRequest } from "../src/shared/github-app.ts";
import { FirestoreRuleStore, RuleStoreError, type CreateAnalysisJobInput, type RuleStoreContext } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "data-flow-secret";
const signed = (event: "installation" | "push", payload: unknown, delivery: string) => { const body = JSON.stringify(payload); return new Request("https://test/webhook", { method: "POST", headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body }); };
const docs = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((snapshot) => snapshot.data()!);
const api = (pull?: GitHubPullRequest): GitHubAppApiClient => ({ getInstallation: async () => { throw new Error("unused"); }, listInstallationRepositories: async () => [], createInstallationAccessToken: async () => ({ token: "x", expires_at: "" }), ...(pull ? { getPullRequest: async () => pull } : {}) });

test("default-branch pushes preserve open RuleBranch PRs and only close remotely closed PRs", async () => {
  for (const [state, expected] of [["open", "draft_open"], ["closed", "closed"]] as const) {
    const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api({ state, merged: false, base: { ref: "main" } }));
    db.put("projects/p", { id: "p", ownerWorkspaceId: "w", status: "active", deletedAt: null });
    db.put("repositories/repo", { id: "repo", ownerWorkspaceId: "w", githubRepoId: "99", projectId: "p", status: "active", defaultBranch: "main" });
    db.put("revision_prs/pr", { id: "pr", ownerWorkspaceId: "w", repositoryId: "repo", prNumber: 7, status: "draft_open" });
    db.put("unique_keys/revision_pr_open:repo", { id: "revision_pr_open:repo", ownerWorkspaceId: "w", targetId: "pr" });
    const payload = { ref: "refs/heads/main", after: "sha", repository: { id: "99", name: "repo", full_name: "acme/repo", default_branch: "main" }, commits: [] };
    await service.receiveWebhook(signed("push", payload, state), secret);
    assert.equal(docs(db, "revision_prs")[0]!.status, expected);
  }
});

test("removed generated paths trigger publish verification", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api());
  db.put("projects/p", { id: "p", ownerWorkspaceId: "w", status: "active", deletedAt: null });
  db.put("repositories/repo", { id: "repo", ownerWorkspaceId: "w", githubRepoId: "99", projectId: "p", status: "active", defaultBranch: "main" });
  db.put("revision_prs/pr", { id: "pr", ownerWorkspaceId: "w", repositoryId: "repo", status: "merged", mergedAt: "2026-01-01", mergeCommitSha: "old" });
  db.put("compiled_artifacts/artifact", { id: "artifact", ownerWorkspaceId: "w", revisionPrId: "pr", path: "AGENTS.md" });
  const payload = { ref: "refs/heads/main", after: "new", repository: { id: "99", name: "repo", full_name: "acme/repo", default_branch: "main" }, commits: [{ added: [], modified: [], removed: ["AGENTS.md"] }] };
  await service.receiveWebhook(signed("push", payload, "removed"), secret);
  assert.equal(docs(db, "analysis_jobs")[0]!.idempotencyKey, "publish_verify:pr:new");
});

test("installation deletion tombstones more than one transaction limit in resumable chunks", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api());
  db.put("unique_keys/github_installation:1", { id: "github_installation:1", ownerWorkspaceId: null, targetId: "installation" });
  db.put("installations/installation", { id: "installation", ownerWorkspaceId: "w", githubInstallationId: "1", status: "active" });
  db.put("workspaces/w", { id: "w", kind: "organization", status: "active" });
  for (let index = 0; index < 451; index += 1) db.put(`projects/p${index}`, { id: `p${index}`, ownerWorkspaceId: "w", deletedAt: null });
  const payload = { action: "deleted", installation: { id: "1", account: { id: "org", login: "acme", type: "Organization" }, repository_selection: "selected" }, sender: { id: "u", login: "u" } };
  assert.equal((await service.receiveWebhook(signed("installation", payload, "delete-large"), secret)).status, 200);
  assert.equal(docs(db, "projects").filter((project) => typeof project.deletedAt === "string").length, 451);
  const deletedAt = docs(db, "installations")[0]!.deletedAt;
  await service.receiveWebhook(signed("installation", payload, "delete-large-again"), secret);
  assert.equal(docs(db, "installations")[0]!.deletedAt, deletedAt);
});

test("soft-deleted workspace and customer documents fail closed at API and job boundaries", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" };
  db.put("workspaces/w", { id: "w", status: "deleted", deletedAt: "2026-01-01" });
  db.put("unique_keys/workspace_member:w:u", { id: "workspace_member:w:u", ownerWorkspaceId: "w", targetId: "m" });
  db.put("workspace_members/m", { id: "m", ownerWorkspaceId: "w", role: "owner" });
  db.put("rules/r", { id: "r", ownerWorkspaceId: "w", deletedAt: "2026-01-01" });
  await assert.rejects(requireRole(store, "w", "u", "viewer"), (error: RuleStoreError) => error.code === "NOT_FOUND");
  assert.equal(await store.get(ctx, "rules", "r"), null);
  assert.deepEqual(await store.list(ctx, "rules"), []);
  await assert.rejects(store.createAnalysisJob(ctx, { type: "compile", projectId: "p", payload: { repositoryId: "r" }, idempotencyKey: "compile:r:x" }), (error: RuleStoreError) => error.code === "WORKSPACE_DELETED");
});

class FailingCompileStore extends FirestoreRuleStore {
  fail = true;
  override async createAnalysisJob(ctx: RuleStoreContext, input: CreateAnalysisJobInput) { if (this.fail && input.type === "compile") throw new Error("dispatch unavailable"); return super.createAnalysisJob(ctx, input); }
}

test("manual approval commits a durable compile intent before post-commit dispatch", async () => {
  const db = new InMemoryFirestore(), store = new FailingCompileStore(db), ctx = { workspaceId: "w", actorUserId: "u" };
  db.put("projects/p", { id: "p", ownerWorkspaceId: "w", status: "active", deletedAt: null });
  db.put("workspaces/w", { id: "w", status: "active" });
  db.put("rules/r", { id: "r", ownerWorkspaceId: "w", title: "Rule", scopeType: "project", projectId: "p", selector: {}, status: "draft", currentVersionId: null });
  db.put("rule_versions/v", { id: "v", ownerWorkspaceId: "w", ruleId: "r", version: 1, status: "proposed", rationale: "why", changeType: "initial", evidenceIds: [], driftFindingIds: [] });
  db.put("repositories/repo", { id: "repo", ownerWorkspaceId: "w", projectId: "p", status: "active" });
  await store.approveRuleVersion(ctx, "v");
  assert.equal((await store.documentRef("rule_versions", "v").get()).data()!.compilePending, true);
  assert.equal(docs(db, "analysis_jobs").length, 0);
  store.fail = false;
  assert.equal(await store.reconcilePendingCompilations(), 1);
  assert.equal((await store.documentRef("rule_versions", "v").get()).data()!.compilePending, false);
  assert.equal(docs(db, "analysis_jobs")[0]!.idempotencyKey, "compile:repo:v");
});

test("proposal jobs derive a missing finding projectId from its rule", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new DriftService(store);
  db.put("projects/p", { id: "p", ownerWorkspaceId: "w", status: "active", deletedAt: null });
  db.put("workspaces/w", { id: "w", status: "active", settings: { allowAiAutoProposal: true } });
  db.put("unique_keys/workspace_member:w:u", { id: "workspace_member:w:u", ownerWorkspaceId: "w", targetId: "m" });
  db.put("workspace_members/m", { id: "m", ownerWorkspaceId: "w", workspaceId: "w", userId: "u", role: "maintainer" });
  db.put("rules/r", { id: "r", ownerWorkspaceId: "w", projectId: "p", currentVersionId: "v" });
  db.put("rule_versions/v", { id: "v", ownerWorkspaceId: "w", ruleId: "r", status: "approved" });
  db.put("drift_findings/f", { id: "f", ownerWorkspaceId: "w", ruleId: "r", ruleVersionId: "v", status: "accepted" });
  await service.propose("w", "u", "f", "request");
  assert.equal(docs(db, "analysis_jobs")[0]!.projectId, "p");
  assert.equal((docs(db, "analysis_jobs")[0]!.payload as Record<string, unknown>).baseRuleVersionId, "v");
});
