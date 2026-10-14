import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { JUDGE_DEMO } from "../src/shared/demo-auth.ts";
import { createProjectRepositoryHandlers } from "../src/shared/http-api.ts";
import { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "project-delete-http-secret";
const workspace = "delete-workspace";
const foreignWorkspace = "foreign-workspace";

function request(userId: string | null, body: Record<string, unknown>, requestedWith = true) {
  return new Request("https://rulebranch.test/api/projects/project", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(requestedWith ? { "x-requested-with": "RuleBranch" } : {}),
      ...(userId ? { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function fixture() {
  const db = new InMemoryFirestore();
  const store = new FirestoreRuleStore(db);
  for (const workspaceId of [workspace, foreignWorkspace]) {
    db.put(`workspaces/${workspaceId}`, { id: workspaceId, kind: "organization", status: "active", deletedAt: null });
  }
  for (const [userId, role] of [["owner", "owner"], ["admin", "admin"], ["maintainer", "maintainer"]] as const) {
    const memberId = `member-${userId}`;
    db.put(`unique_keys/workspace_member:${workspace}:${userId}`, { ownerWorkspaceId: workspace, targetId: memberId });
    db.put(`workspace_members/${memberId}`, { id: memberId, ownerWorkspaceId: workspace, workspaceId: workspace, userId, role, deletedAt: null });
  }
  db.put("projects/project", { id: "project", ownerWorkspaceId: workspace, name: "Delete Me", slug: "delete-me", status: "active", deletedAt: null });
  db.put("projects/foreign-project", { id: "foreign-project", ownerWorkspaceId: foreignWorkspace, name: "Foreign", slug: "foreign", status: "active", deletedAt: null });
  const service = new ProjectRepositoryService(store, { listInstallationRepositories: async () => [] });
  return { db, handlers: createProjectRepositoryHandlers(service, secret) };
}

async function error(response: Response) {
  return await response.json() as { error: string };
}

test("project DELETE requires CSRF protection and an authenticated session", async () => {
  const f = fixture();
  const csrf = await f.handlers.deleteProject(request("owner", { workspaceId: workspace, confirmName: "Delete Me" }, false), "project");
  assert.equal(csrf.status, 403);
  assert.equal((await error(csrf)).error, "MISSING_REQUESTED_WITH_HEADER");

  const anonymous = await f.handlers.deleteProject(request(null, { workspaceId: workspace, confirmName: "Delete Me" }), "project");
  assert.equal(anonymous.status, 401);
  assert.equal((await error(anonymous)).error, "UNAUTHENTICATED");
  assert.equal(f.db.snapshot("projects", "project").data()?.deletedAt, null);
});

test("project DELETE enforces exact confirmation and admin role", async () => {
  const f = fixture();
  const mismatch = await f.handlers.deleteProject(request("owner", { workspaceId: workspace, confirmName: "delete me" }), "project");
  assert.equal(mismatch.status, 422);
  assert.equal((await error(mismatch)).error, "PROJECT_NAME_MISMATCH");

  const denied = await f.handlers.deleteProject(request("maintainer", { workspaceId: workspace, confirmName: "Delete Me" }), "project");
  assert.equal(denied.status, 403);
  assert.equal((await error(denied)).error, "FORBIDDEN");
  assert.equal(f.db.snapshot("projects", "project").data()?.deletedAt, null);
});

test("project DELETE does not disclose or change a foreign workspace project", async () => {
  const f = fixture();
  const response = await f.handlers.deleteProject(request("owner", { workspaceId: workspace, confirmName: "Foreign" }), "foreign-project");
  assert.equal(response.status, 404);
  assert.equal((await error(response)).error, "NOT_FOUND");
  assert.equal(f.db.snapshot("projects", "foreign-project").data()?.deletedAt, null);
});

test("project DELETE succeeds for admins and a replay fails closed without a second audit", async () => {
  const f = fixture();
  const first = await f.handlers.deleteProject(request("admin", { workspaceId: workspace, confirmName: "Delete Me", requestId: "delete-once" }), "project");
  assert.equal(first.status, 200);
  const project = (await first.json() as { project: Record<string, unknown> }).project;
  assert.equal(project.status, "archived");
  assert.equal(typeof project.deletedAt, "string");

  const replay = await f.handlers.deleteProject(request("admin", { workspaceId: workspace, confirmName: "Delete Me", requestId: "delete-once" }), "project");
  assert.equal(replay.status, 404);
  assert.equal((await error(replay)).error, "NOT_FOUND");
  assert.equal(f.db.query("audit_logs", []).filter((item) => item.data()?.action === "project.delete").length, 1);
});

test("project DELETE rejects a demo session before calling the service", async () => {
  let calls = 0;
  const service = { deleteProject: async () => { calls += 1; return {}; } } as unknown as ProjectRepositoryService;
  const handlers = createProjectRepositoryHandlers(service, secret);
  const response = await handlers.deleteProject(request(JUDGE_DEMO.userId, { workspaceId: JUDGE_DEMO.workspaceId, confirmName: "Demo" }), JUDGE_DEMO.projectId);
  assert.equal(response.status, 403);
  assert.equal((await error(response)).error, "DEMO_READ_ONLY");
  assert.equal(calls, 0);
});
