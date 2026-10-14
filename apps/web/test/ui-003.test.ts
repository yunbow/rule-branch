import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { GitHubAppService, type GitHubAppApiClient, type GitHubInstallationPayload } from "../src/shared/github-app.ts";
import { createGitHubAppHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

class FakeApp implements GitHubAppApiClient {
  async getInstallation(_id: string): Promise<GitHubInstallationPayload> { throw new Error("unused"); }
  async listInstallationRepositories(_id: string) { return [{ id: "repo-1", name: "repo", full_name: "acme/repo" }]; }
  async createInstallationAccessToken(_id: string, _jwt: string) { return { token: "token", expires_at: "2026-01-01T00:00:00Z" }; }
}
function member(db: InMemoryFirestore, workspaceId: string, userId: string, role = "viewer") { db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, { targetId: `member-${workspaceId}-${userId}` }); db.put(`workspace_members/member-${workspaceId}-${userId}`, { id: `member-${workspaceId}-${userId}`, workspaceId, userId, role }); }
function request(path: string, userId?: string) { return new Request(`https://app.test${path}`, { headers: userId ? { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, "secret")}` } : {} }); }

test("UI-003 installations APIs enforce session and installation workspace membership", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), service = new GitHubAppService(store, new FakeApp()), handlers = createGitHubAppHandlers(service, "secret", "hook");
  db.put("installations/installation-1", { id: "installation-1", ownerWorkspaceId: "workspace-a", githubInstallationId: "123", accountType: "Organization", accountLogin: "acme", repositorySelection: "selected", status: "active", installedAt: "2026-01-01T00:00:00Z" });
  assert.equal((await handlers.installations(request("/api/installations?workspaceId=workspace-a"))).status, 401);
  member(db, "workspace-a", "viewer"); member(db, "workspace-b", "other");
  const list = await handlers.installations(request("/api/installations?workspaceId=workspace-a", "viewer")); assert.equal(list.status, 200); assert.deepEqual(await list.json(), { installations: [{ id: "installation-1", githubInstallationId: "123", accountType: "Organization", accountLogin: "acme", repositorySelection: "selected", status: "active", installedAt: "2026-01-01T00:00:00Z" }] });
  assert.equal((await handlers.repositories(request("/api/installations/123/repositories"), "123")).status, 401);
  assert.equal((await handlers.repositories(request("/api/installations/123/repositories", "other"), "123")).status, 403);
  const repositories = await handlers.repositories(request("/api/installations/123/repositories", "viewer"), "123"); assert.equal(repositories.status, 200);
});
