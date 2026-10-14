import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { createJobHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { mergeProjectJobs, shouldPollJob, shouldPollProjectJobs } from "../src/lib/hooks/job-polling-policy.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "secret";
const request = (path: string, userId?: string) => new Request(`https://app.test${path}`, { headers: userId ? { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}` } : {} });
function member(db: InMemoryFirestore, workspaceId: string, userId: string) { db.put(`unique_keys/workspace_member:${workspaceId}:${userId}`, { targetId: `member-${workspaceId}-${userId}` }); db.put(`workspace_members/member-${workspaceId}-${userId}`, { id: `member-${workspaceId}-${userId}`, workspaceId, userId, role: "viewer" }); }
function job(id: string, workspaceId: string, type: string, createdAt: string) { return { id, ownerWorkspaceId: workspaceId, projectId: "project", type, status: "queued", attempts: 0, idempotencyKey: `${type}:${id}`, payload: {}, warnings: [], warningsOverflow: 0, error: null, createdAt, startedAt: null, finishedAt: null }; }

test("UI-004 job handlers require authentication, isolate workspaces, and filter project jobs", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), handlers = createJobHandlers(store, secret);
  db.put("analysis_jobs/other-job", job("other-job", "other", "bootstrap", "2026-01-01T00:00:00.000Z"));
  assert.equal((await handlers.get(request("/api/jobs/other-job?workspaceId=workspace"), "other-job")).status, 401);
  member(db, "workspace", "viewer");
  db.put("projects/project", { id: "project", ownerWorkspaceId: "workspace", status: "active", deletedAt: null });
  assert.equal((await handlers.get(request("/api/jobs/other-job?workspaceId=workspace", "viewer"), "other-job")).status, 404);
  db.put("analysis_jobs/bootstrap-job", job("bootstrap-job", "workspace", "bootstrap", "2026-01-02T00:00:00.000Z"));
  db.put("analysis_jobs/compile-job", job("compile-job", "workspace", "compile", "2026-01-03T00:00:00.000Z"));
  const response = await handlers.listProject(request("/api/projects/project/jobs?workspaceId=workspace&type=bootstrap", "viewer"), "project");
  assert.equal(response.status, 200); assert.deepEqual((await response.json() as { jobs: Array<{ id: string }> }).jobs.map((item) => item.id), ["bootstrap-job"]);
});
test("UI-004 polling policy only runs active jobs in visible tabs", () => {
  assert.equal(shouldPollJob("queued", false), true); assert.equal(shouldPollJob("running", false), true);
  assert.equal(shouldPollJob("done", false), false); assert.equal(shouldPollJob("failed", false), false); assert.equal(shouldPollJob("dead", false), false); assert.equal(shouldPollJob("running", true), false);
  assert.equal(shouldPollJob("running", false, false), false);
});
test("UI-004 project polling uses one loop for all active rows and can exclude the featured job", () => {
  const jobs = [{ id: "queued", status: "queued" }, { id: "running", status: "running" }, { id: "done", status: "done" }];
  assert.equal(shouldPollProjectJobs(jobs, false), true);
  assert.equal(shouldPollProjectJobs(jobs, true), false);
  assert.equal(shouldPollProjectJobs([{ id: "featured", status: "running" }], false, "featured"), false);
  assert.equal(shouldPollProjectJobs([{ id: "featured", status: "running" }, { id: "other", status: "queued" }], false, "featured"), true);
});
test("UI-004 project polling adopts server order and merges updated state", () => {
  const current = [{ id: "old", status: "running", type: "compile", local: true }, { id: "done", status: "done", type: "bootstrap", local: true }];
  const incoming = [{ id: "new", status: "queued", type: "proposal", local: false }, { id: "old", status: "done", type: "compile", local: false }];
  assert.deepEqual(mergeProjectJobs(current, incoming), incoming);
});
