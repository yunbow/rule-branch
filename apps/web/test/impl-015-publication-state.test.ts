import assert from "node:assert/strict";
import test from "node:test";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

test("IMPL-015 derives verified, partial, open, and mismatch publication states from snapshots", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" as string | null };
  const put = (c: string, id: string, value: Record<string, unknown>) => db.put(`${c}/${id}`, { id, ownerWorkspaceId: "w", ...value });
  put("projects", "p", { status: "active", deletedAt: null });
  put("rules", "rule", { scopeType: "organization", scopeId: "w", status: "active", selector: {} }); put("rule_versions", "v", { ruleId: "rule" });
  put("repositories", "a", { status: "active", projectId: "p" }); put("repositories", "b", { status: "active", projectId: "p" }); put("resolution_snapshots", "s", { ruleVersionIds: ["v"] });
  put("revision_prs", "ma", { repositoryId: "a", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "s", verification: { state: "verified", checkedCommitSha: "repair" } });
  put("revision_prs", "ob", { repositoryId: "b", status: "draft_open", resolutionSnapshotId: "s", prUrl: "pr" });
  let state = await store.getPublicationState(ctx, "v"); assert.equal(state.aggregate, "partially_published"); assert.equal((state.perRepository as any[])[0].commitSha, "repair");
  put("revision_prs", "mb", { repositoryId: "b", status: "merged", mergedAt: "2026-01-02", resolutionSnapshotId: "s", verification: { state: "mismatch", checkedCommitSha: "bad" } });
  state = await store.getPublicationState(ctx, "v"); assert.equal(state.aggregate, "partially_published"); assert.equal((state.perRepository as any[]).find((x) => x.repositoryId === "b").state, "pr_open");
});

test("publication states batch shared collection queries across rule versions", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" as string | null };
  const put = (collection: string, id: string, value: Record<string, unknown>) => db.put(`${collection}/${id}`, { id, ownerWorkspaceId: "w", ...value });
  put("projects", "p1", { status: "active", deletedAt: null }); put("projects", "p2", { status: "active", deletedAt: null });
  put("rules", "r1", { scopeType: "organization", selector: {} });
  put("rules", "r2", { scopeType: "project", projectId: "p2", selector: {} });
  put("rule_versions", "v1", { ruleId: "r1" });
  put("rule_versions", "v2", { ruleId: "r2" });
  put("repositories", "a", { status: "active", projectId: "p1" });
  put("repositories", "b", { status: "active", projectId: "p2" });
  put("repositories", "removed", { status: "removed", projectId: "p2" });
  put("resolution_snapshots", "s", { ruleVersionIds: ["v1", "v2"] });
  put("revision_prs", "merged-a", { repositoryId: "a", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "s", verification: { state: "verified" } });
  put("revision_prs", "open-b", { repositoryId: "b", status: "draft_open", resolutionSnapshotId: "s" });
  put("revision_prs", "mismatch-b", { repositoryId: "b", status: "merged", mergedAt: "2026-01-02", resolutionSnapshotId: "s", verification: { state: "mismatch" } });
  put("revision_prs", "closed-history", { repositoryId: "b", status: "closed", resolutionSnapshotId: "s" });
  for (let index = 0; index < 200; index += 1) put("resolution_snapshots", `historical-${index}`, { ruleVersionIds: ["v1"] });
  db.put("repositories/foreign", { id: "foreign", ownerWorkspaceId: "other", status: "active", projectId: "p2" });
  db.put("resolution_snapshots/foreign", { id: "foreign", ownerWorkspaceId: "other", ruleVersionIds: ["v1", "v2"] });
  db.put("revision_prs/foreign", { id: "foreign", ownerWorkspaceId: "other", repositoryId: "foreign", status: "merged", mergedAt: "2026-01-03", resolutionSnapshotId: "foreign", verification: { state: "verified" } });

  const states = await store.getPublicationStates(ctx, ["v1", "v2", "v1"]);

  assert.equal(states.v1.aggregate, "partially_published");
  assert.equal(states.v2.aggregate, "pr_open");
  assert.deepEqual((states.v1.perRepository as Array<{ repositoryId: string }>).map((item) => item.repositoryId), ["a", "b"]);
  assert.equal((states.v2.perRepository as Array<{ verification: string }>)[0].verification, "mismatch");
  assert.equal(db.queryCounts.get("repositories"), 1);
  assert.equal(db.queryCounts.get("revision_prs"), 2);
  assert.equal(db.queryCounts.get("resolution_snapshots"), undefined);
  assert.equal(db.getAllCalls, 11);
  assert.deepEqual(db.getAllBatches, [
    ["rule_versions/v1", "rule_versions/v2"],
    ["rules/r1", "rules/r2"],
    ["projects/p2"],
    ["rules/r1", "rules/r2"],
    ["projects/p2"],
    ["projects/p1", "projects/p2"],
    ["repositories/b"],
    ["repositories/a", "repositories/b"],
    ["projects/p2"],
    ["projects/p1", "projects/p2"],
    ["resolution_snapshots/s"],
  ]);
});

test("publication state only trusts current PR snapshot references within the tenant", async () => {
  const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" as string | null };
  const put = (collection: string, id: string, value: Record<string, unknown>) => db.put(`${collection}/${id}`, { id, ownerWorkspaceId: "w", ...value });
  put("projects", "p", { status: "active", deletedAt: null });
  put("rules", "rule", { scopeType: "project", projectId: "p", selector: { repositoryIds: ["selected", "missing", "foreign", "deleted"] } });
  put("rule_versions", "v", { ruleId: "rule" });
  for (const id of ["selected", "unselected", "missing", "foreign", "deleted"]) put("repositories", id, { status: "active", projectId: "p" });
  put("resolution_snapshots", "old-includes", { ruleVersionIds: ["v"] });
  put("resolution_snapshots", "latest-excludes", { ruleVersionIds: [] });
  put("resolution_snapshots", "open-includes", { ruleVersionIds: ["v"] });
  db.put("resolution_snapshots/foreign-snapshot", { id: "foreign-snapshot", ownerWorkspaceId: "other", ruleVersionIds: ["v"] });
  put("resolution_snapshots", "deleted-snapshot", { ruleVersionIds: ["v"], deletedAt: "2026-01-01" });
  put("revision_prs", "selected-old", { repositoryId: "selected", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "old-includes", verification: { state: "verified" } });
  put("revision_prs", "selected-latest", { repositoryId: "selected", status: "merged", mergedAt: "2026-01-02", resolutionSnapshotId: "latest-excludes", verification: { state: "verified" } });
  put("revision_prs", "selected-open", { repositoryId: "selected", status: "draft_open", resolutionSnapshotId: "open-includes" });
  put("revision_prs", "missing", { repositoryId: "missing", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "absent", verification: { state: "verified" } });
  put("revision_prs", "foreign", { repositoryId: "foreign", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "foreign-snapshot", verification: { state: "verified" } });
  put("revision_prs", "deleted", { repositoryId: "deleted", status: "merged", mergedAt: "2026-01-01", resolutionSnapshotId: "deleted-snapshot", verification: { state: "verified" } });

  const state = await store.getPublicationState(ctx, "v");
  const byRepository = new Map((state.perRepository as Array<{ repositoryId: string; state: string }>).map((item) => [item.repositoryId, item.state]));
  assert.equal(byRepository.get("selected"), "pr_open");
  assert.equal(byRepository.get("unselected"), undefined);
  assert.equal(byRepository.get("missing"), "not_published");
  assert.equal(byRepository.get("foreign"), "not_published");
  assert.equal(byRepository.get("deleted"), "not_published");
  assert.ok(!db.getAllBatches.flat().includes("resolution_snapshots/old-includes"));
});

test("publication state batch fails closed for missing, deleted, or cross-tenant versions and rules", async () => {
  for (const kind of ["missing", "deleted", "foreign"] as const) {
    const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" as string | null };
    if (kind !== "missing") db.put("rule_versions/v", { id: "v", ownerWorkspaceId: kind === "foreign" ? "other" : "w", ruleId: "r", ...(kind === "deleted" ? { deletedAt: "2026-01-01" } : {}) });
    await assert.rejects(store.getPublicationStates(ctx, ["v"]), (error: unknown) => error instanceof Error && error.message === "NOT_FOUND");
  }
  for (const kind of ["missing", "deleted", "foreign"] as const) {
    const db = new InMemoryFirestore(), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" as string | null };
    db.put("rule_versions/v", { id: "v", ownerWorkspaceId: "w", ruleId: "r" });
    if (kind !== "missing") db.put("rules/r", { id: "r", ownerWorkspaceId: kind === "foreign" ? "other" : "w", ...(kind === "deleted" ? { deletedAt: "2026-01-01" } : {}) });
    await assert.rejects(store.getPublicationStates(ctx, ["v"]), (error: unknown) => error instanceof Error && error.message === "NOT_FOUND");
  }
});
