import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { ENUMS } from "../src/shared/contracts.ts";
import { DriftService } from "../src/shared/drift.ts";
import { GitHubAppService, type GitHubAppApiClient } from "../src/shared/github-app.ts";
import { createDriftHandlers, createEvidenceHandlers, createGitHubAppHandlers, createJobHandlers, createMeHandlers, createRuleHandlers, createUserPreferencesHandlers } from "../src/shared/http-api.ts";
import { RulesService } from "../src/shared/rules.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { UserPreferencesService } from "../src/shared/user-preferences.ts";
import { LABELS, getStatusLabel } from "../src/lib/labels.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "http-api-guards-secret";
const request = (url: string, opts: { userId?: string; body?: Record<string, unknown>; requestedWith?: boolean } = {}) => {
  const { userId, body, requestedWith = body !== undefined } = opts;
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (requestedWith) headers["x-requested-with"] = "RuleBranch";
  return new Request(url, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
};
const stubGitHubApi: GitHubAppApiClient = { async getInstallation() { throw new Error("unused"); }, async listInstallationRepositories() { return []; }, async createInstallationAccessToken() { return { token: "t", expires_at: "2026-01-01T00:00:00Z" }; } };

test("A: unauthenticated requests uniformly return UNAUTHENTICATED with empty details", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db);
  const me = createMeHandlers(store, secret), prefs = createUserPreferencesHandlers(new UserPreferencesService(store), secret);
  const githubApp = createGitHubAppHandlers(new GitHubAppService(store, stubGitHubApi), secret, "hook-secret");
  const evidence = createEvidenceHandlers(store, secret), jobs = createJobHandlers(store, secret);
  const cases: Array<[string, () => Promise<Response>]> = [
    ["me.get", () => me.get(request("https://test/api/me"))],
    ["userPreferences.get", () => prefs.get(request("https://test/api/preferences"))],
    ["userPreferences.patch", () => prefs.patch(request("https://test/api/preferences", { body: {} }))],
    ["githubApp.installations", () => githubApp.installations(request("https://test/api/installations?workspaceId=w"))],
    ["githubApp.repositories", () => githubApp.repositories(request("https://test/api/installations/123/repositories"), "123")],
    ["evidence.list", () => evidence.list(request("https://test/api/evidence?workspaceId=w"))],
    ["jobs.listProject", () => jobs.listProject(request("https://test/api/projects/p/jobs?workspaceId=w"), "p")],
  ];
  for (const [name, call] of cases) {
    const response = await call();
    assert.equal(response.status, 401, name);
    assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED", details: {} }, name);
  }
});

test("B: CSRF rejection precedes the auth guard on write handlers", async () => {
  const prefs = createUserPreferencesHandlers(new UserPreferencesService(new FirestoreRuleStore(new InMemoryFirestore())), secret);
  const response = await prefs.patch(new Request("https://test/api/preferences", { method: "PATCH", body: "{}" }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "MISSING_REQUESTED_WITH_HEADER" });
});

test("B(ii): a browser mutation with RuleBranch's header must still be same-origin", async () => {
  const prefs = createUserPreferencesHandlers(new UserPreferencesService(new FirestoreRuleStore(new InMemoryFirestore())), secret);
  const response = await prefs.patch(new Request("https://app.example.test/api/preferences", {
    method: "PATCH",
    headers: { "x-requested-with": "RuleBranch", origin: "https://untrusted.example.test", "sec-fetch-site": "same-site" },
    body: "{}",
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "CROSS_ORIGIN_REQUEST" });
});

test("B(iii): browser mutations use the configured public origin behind a proxy", async () => {
  const previousPublicUrl = process.env.RULEBRANCH_PUBLIC_URL;
  process.env.RULEBRANCH_PUBLIC_URL = "https://app.example.test";
  try {
    const prefs = createUserPreferencesHandlers(new UserPreferencesService(new FirestoreRuleStore(new InMemoryFirestore())), secret);
    const response = await prefs.patch(new Request("http://0.0.0.0:8080/api/preferences", {
      method: "PATCH",
      headers: { "x-requested-with": "RuleBranch", origin: "https://app.example.test", "sec-fetch-site": "same-origin" },
      body: "{}",
    }));
    assert.notEqual(response.status, 403);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.RULEBRANCH_PUBLIC_URL;
    else process.env.RULEBRANCH_PUBLIC_URL = previousPublicUrl;
  }
});

test("C(i): query-based workspaceId guard rejects missing and empty workspaceId with 422", async () => {
  const evidence = createEvidenceHandlers(new FirestoreRuleStore(new InMemoryFirestore()), secret);
  for (const url of ["https://test/api/evidence", "https://test/api/evidence?workspaceId="]) {
    const response = await evidence.list(request(url, { userId: "user-c1" }));
    assert.equal(response.status, 422, url);
    assert.deepEqual(await response.json(), { error: "INVALID_WORKSPACE_ID", details: {} }, url);
  }
});

test("C(ii): body-based workspaceId guard rejects missing, empty, and non-string ownerWorkspaceId with 422", async () => {
  const rules = createRuleHandlers(new RulesService(new FirestoreRuleStore(new InMemoryFirestore())), secret);
  for (const body of [{}, { ownerWorkspaceId: "" }, { ownerWorkspaceId: 5 }]) {
    const response = await rules.create(request("https://test/api/rules", { body, requestedWith: true }));
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "INVALID_WORKSPACE_ID", details: {} }, JSON.stringify(body));
  }
});

test("C(iii): drift handlers accept a workspaceId from either the body or the query string", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), workspaceId = "ws-drift", userId = "user-drift";
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspace_members", "member-drift"), { id: "member-drift", workspaceId, userId, role: "member" });
    tx.create(store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`), { id: `workspace_member:${workspaceId}:${userId}`, targetId: "member-drift" });
    tx.create(store.documentRef("projects", "project-drift"), { id: "project-drift", ownerWorkspaceId: workspaceId });
  });
  db.put("repositories/repo-drift", { id: "repo-drift", ownerWorkspaceId: workspaceId, projectId: "project-drift", status: "active" });
  const handlers = createDriftHandlers(new DriftService(store), secret);
  const triggerResponse = await handlers.trigger(request("https://test/projects/project-drift/drift-triggers", { userId, body: { ownerWorkspaceId: workspaceId }, requestedWith: true }), "project-drift");
  assert.notEqual((await triggerResponse.json() as { error?: string }).error, "INVALID_WORKSPACE_ID");
  const listResponse = await handlers.list(request(`https://test/drift-findings?workspaceId=${workspaceId}`, { userId }));
  assert.notEqual((await listResponse.json() as { error?: string }).error, "INVALID_WORKSPACE_ID");
});

test("D: LABELS.driftType and LABELS['rule_relations.validationStatus'] key sets equal their ENUMS contract", () => {
  assert.deepEqual(Object.keys(LABELS.driftType), [...ENUMS["drift_findings.driftType"]]);
  assert.deepEqual(Object.keys(LABELS["rule_relations.validationStatus"]), [...ENUMS["rule_relations.validationStatus"]]);
});

test("D: every other LABELS key that literally names an ENUMS key lines up with (or is a subset of) that enum", () => {
  const sharedKeys = Object.keys(LABELS).filter((key) => key in ENUMS);
  assert.ok(sharedKeys.includes("rules.status") && sharedKeys.includes("enforcement"));
  for (const key of sharedKeys) {
    const enumValues = ENUMS[key as keyof typeof ENUMS] as readonly string[], labelKeys = Object.keys(LABELS[key]);
    // analysis_jobs.type intentionally omits pr_review/impact — the UI does not surface those job types, so it is checked as a subset rather than an exact match.
    if (key === "analysis_jobs.type") { for (const labelKey of labelKeys) assert.ok(enumValues.includes(labelKey), `${key}.${labelKey}`); continue; }
    assert.deepEqual(labelKeys.sort(), [...enumValues].sort(), key);
  }
});

test("D: getStatusLabel resolves the relation validation status label", () => {
  assert.equal(getStatusLabel("rule_relations.validationStatus", "unchecked").label, "未検証");
});

