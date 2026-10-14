import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { GitHubAppService, type GitHubAppApiClient, type GitHubPullRequest } from "../src/shared/github-app.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "hook-secret";
const signed = (payload: unknown, event: "pull_request" | "push", delivery: string) => { const body = JSON.stringify(payload); return new Request("https://app.test/webhook", { method: "POST", headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body }); };
const all = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((x) => x.data()!);
class FakeGitHub implements GitHubAppApiClient {
  pull: GitHubPullRequest = { merged: true, merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: "commit", base: { ref: "main" } }; calls = 0;
  async getInstallation(): Promise<any> { throw new Error("unused"); } async listInstallationRepositories(): Promise<any[]> { return []; } async createInstallationAccessToken(): Promise<any> { return { token: "x", expires_at: "x" }; }
  async getPullRequest(): Promise<GitHubPullRequest> { this.calls += 1; return this.pull; }
}
function seed(number = 7) {
  const db = new InMemoryFirestore(), api = new FakeGitHub(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, api);
  const put = (collection: string, id: string, data: Record<string, unknown>) => db.put(`${collection}/${id}`, { id, ownerWorkspaceId: "w", ...data });
  put("projects", "p", { status: "active", deletedAt: null });
  put("repositories", "repo", { githubRepoId: "99", projectId: "p", status: "active", defaultBranch: "main" });
  put("revision_prs", "rp", { repositoryId: "repo", projectId: "p", prNumber: number, status: "draft_open", resolutionSnapshotId: "snap", prUrl: "https://pr/7" });
  put("unique_keys", "revision_pr_open:repo", { kind: "revision_pr_open", targetTable: "revision_prs", targetId: "rp" });
  return { db, api, service, put };
}
const closed = (merged: boolean, base = "main", number = 7, sha = "commit") => ({ action: "closed", number, repository: { id: "99", default_branch: "main" }, pull_request: { merged, merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: sha, base: { ref: base } } });
const push = (paths: string[] = [], after = "commit") => ({ ref: "refs/heads/main", after, repository: { id: "99", default_branch: "main" }, commits: [{ added: paths, modified: [] }] });

test("IMPL-015 ignores non-RuleBranch PRs", async () => {
  const { db, service } = seed(); const before = structuredClone(all(db, "revision_prs"));
  assert.equal((await service.receiveWebhook(signed(closed(true, "main", 88), "pull_request", "other"), secret)).status, 200);
  assert.deepEqual(all(db, "revision_prs"), before); assert.equal(all(db, "analysis_jobs").length, 0); assert.equal(all(db, "audit_logs").length, 0);
});

test("closed merge records pending verification, frees draft key, and enqueues exactly one job", async () => {
  const { db, service } = seed(); await service.receiveWebhook(signed(closed(true), "pull_request", "merged"), secret);
  const pr = all(db, "revision_prs")[0]!; assert.equal(pr.status, "merged"); assert.equal(pr.mergeCommitSha, "commit"); assert.equal((pr.verification as any).state, "pending");
  assert.equal(all(db, "unique_keys").some((x) => x.id === "revision_pr_open:repo"), false); assert.equal(all(db, "audit_logs").some((x) => x.action === "pr.merged"), true);
  const jobs = all(db, "analysis_jobs"); assert.equal(jobs.length, 1); assert.equal(jobs[0]!.idempotencyKey, "publish_verify:rp:commit");
});

test("closed non-merge and non-default merge close rather than publish", async () => {
  for (const [name, event] of [["unmerged", closed(false)], ["other-base", closed(true, "release")]] as const) {
    const { db, service } = seed(); await service.receiveWebhook(signed(event, "pull_request", name), secret);
    assert.equal(all(db, "revision_prs")[0]!.status, "closed"); assert.equal(all(db, "unique_keys").length, 0); assert.equal(all(db, "audit_logs").some((x) => x.action === "pr.closed"), true); assert.equal(all(db, "analysis_jobs").length, 0);
  }
});

test("push reconciles a missed closed event via injected PR API", async () => {
  const { db, api, service } = seed(); await service.receiveWebhook(signed(push(), "push", "reconcile"), secret);
  const pr = all(db, "revision_prs")[0]!; assert.equal(api.calls, 1); assert.equal(pr.status, "merged"); assert.equal(pr.mergeCommitSha, "commit"); assert.equal((pr.verification as any).state, "pending"); assert.equal(all(db, "analysis_jobs").length, 1);
});

test("push only verifies changed artifact paths and deduplicates the merge job", async () => {
  const { db, service, put } = seed(); put("compiled_artifacts", "a", { revisionPrId: "rp", resolutionSnapshotId: "snap", path: ".rulebranch/rules/L1/x.md", gitBlobSha: "blob" });
  await service.receiveWebhook(signed(closed(true), "pull_request", "merge"), secret);
  await service.receiveWebhook(signed(push(["README.md"]), "push", "unrelated"), secret); assert.equal(all(db, "analysis_jobs").length, 1);
  await service.receiveWebhook(signed(push([".rulebranch/rules/L1/x.md"]), "push", "changed"), secret);
  assert.equal(all(db, "analysis_jobs").length, 1); assert.equal(all(db, "analysis_jobs")[0]!.idempotencyKey, "publish_verify:rp:commit");
});

test("a changed artifact path on an already merged PR enqueues push verification only", async () => {
  const { db, service, put } = seed(); put("revision_prs", "rp", { repositoryId: "repo", projectId: "p", prNumber: 7, status: "merged", mergedAt: "2026-01-01", mergeCommitSha: "commit", resolutionSnapshotId: "snap" });
  put("compiled_artifacts", "a", { revisionPrId: "rp", resolutionSnapshotId: "snap", path: "AGENTS.md", gitBlobSha: "blob" });
  await service.receiveWebhook(signed(push(["README.md"]), "push", "no-artifact"), secret); assert.equal(all(db, "analysis_jobs").length, 0);
  await service.receiveWebhook(signed(push(["AGENTS.md"]), "push", "artifact"), secret); const job = all(db, "analysis_jobs")[0]!;
  assert.equal(job.idempotencyKey, "publish_verify:rp:commit"); assert.equal((job.payload as any).reason, "push");
});

test("push arriving before closed compares artifacts to the newly merged PR", async () => {
  const { db, service, put } = seed();
  put("revision_prs", "old", { repositoryId: "repo", projectId: "p", prNumber: 1, status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "old-snap" });
  for (const id of ["old", "rp"]) put("compiled_artifacts", id, { revisionPrId: id, path: "AGENTS.md", gitBlobSha: id });
  await service.receiveWebhook(signed(push(["AGENTS.md"]), "push", "push-before-closed"), secret);
  const jobs = all(db, "analysis_jobs");
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.payload as any).revisionPrId, "rp");
  await service.receiveWebhook(signed(closed(true), "pull_request", "late-closed"), secret);
  assert.equal(all(db, "analysis_jobs").length, 1);
});
