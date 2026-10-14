import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FirestoreRuleStore, RULE_STORE_METHOD_SIGNATURES, RuleStoreError, canonicalJson, requireHumanActor, sha256, uniqueKeyId, withHumanActorGuard, type RuleStoreContext } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const ctx = { workspaceId: "workspace-a", actorUserId: "user-a" };
const entry = { actor: { kind: "user" as const, id: "user-a" }, action: "rule.create", targetType: "rules", targetId: "rule-a", requestId: "request-a" };
test("tenant reads and lists never reveal another workspace", async () => {
  const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db);
  await db.runTransaction(async (tx) => { tx.create(db.collection("rules").doc("other"), { ownerWorkspaceId: "workspace-b" }); });
  assert.equal(await store.get(ctx, "rules", "other"), null); assert.deepEqual(await store.list(ctx, "rules"), []);
});
test("server-side joins use one batch point-read RPC", async () => {
  const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db);
  db.put("users/a", { id: "a" }); db.put("users/b", { id: "b" });
  assert.deepEqual((await store.getServerDocuments("users", ["a", "missing", "b", "a"])).map((item) => item.id), ["a", "b"]);
  assert.equal(db.getAllCalls, 1);
});
test("same unique key raced in transactions has exactly one winner", async () => {
  const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db); let arrivals = 0; let open!: () => void; const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
  const reserve = () => store.runTransaction(async (tx) => { if (arrivals++ < 2) { if (arrivals === 2) open(); await gate; } await store.reserveUniqueKey(tx, "project_slug", { ownerWorkspaceId: "workspace-a", slug: "alpha" }, { targetTable: "projects", targetId: "p1" }); });
  const result = await Promise.allSettled([reserve(), reserve()]); assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = result.find((item): item is PromiseRejectedResult => item.status === "rejected")!.reason as RuleStoreError;
  assert.equal(rejected.status, 409); assert.equal(rejected.code, "UNIQUE_VIOLATION"); assert.deepEqual(rejected.details, { kind: "project_slug", value: "workspace-a:alpha" });
});
test("all twelve unique-key document IDs exactly follow DM 5.27", () => {
  const cases: [Parameters<typeof uniqueKeyId>[0], Record<string, string>, string][] = [
    ["github_user", { githubUserId: "1" }, "github_user:1"], ["user_preference", { userId: "u" }, "user_preference:u"], ["github_org", { githubOrgId: "2" }, "github_org:2"], ["github_installation", { githubInstallationId: "3" }, "github_installation:3"], ["github_repo", { githubRepoId: "4" }, "github_repo:4"], ["workspace_member", { workspaceId: "w", userId: "u" }, "workspace_member:w:u"], ["workspace_invitation_pending", { workspaceId: "w", invitedGithubUserId: "5" }, "workspace_invitation_pending:w:5"], ["project_slug", { ownerWorkspaceId: "w", slug: "p" }, "project_slug:w:p"], ["rule_key", { ownerWorkspaceId: "w", scopeType: "project", scopeId: "p", key: "r" }, "rule_key:w:project:p:r"], ["rule_relation_child", { childRuleId: "r" }, "rule_relation_child:r"], ["revision_pr_open", { repositoryId: "r" }, "revision_pr_open:r"], ["job_idempotency", { idempotencyKeyHash: "a".repeat(64) }, `job_idempotency:${"a".repeat(64)}`],
  ]; for (const [kind, components, expected] of cases) assert.equal(uniqueKeyId(kind, components), expected);
});
test("write #451 fails before transaction commit", async () => { const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db); await assert.rejects(store.runTransaction(async (tx) => { for (let i = 0; i < 451; i += 1) tx.create(db.collection("rules").doc(String(i)), { ownerWorkspaceId: "workspace-a" }); }), (error: RuleStoreError) => error.details.maxTransactionWrites === 450); assert.equal((await store.list(ctx, "rules")).length, 0); });
test("audit payload is canonical-hashed and large payloads are truncated", async () => { const db = new InMemoryFirestore(); const store = new FirestoreRuleStore(db); const before = { z: 1, a: "x".repeat(33 * 1024) }; const after = { b: 2 }; await store.appendAuditLog(ctx, { ...entry, before, after }); const [audit] = await store.list(ctx, "audit_logs"); assert.deepEqual(audit.before, { _truncated: true, sha256: sha256(before) }); assert.equal(audit.payloadHash, sha256({ before, after })); assert.equal(audit.retentionClass, "audit"); assert.equal(canonicalJson({ z: 1, a: 2 }), '{"a":2,"z":1}'); await assert.rejects(store.appendAuditLog(ctx, { ...entry, requestId: "" })); });
test("audit has no ordinary mutation APIs and redaction is system-only", async () => { const store = new FirestoreRuleStore(new InMemoryFirestore()); assert.equal("updateAuditLog" in store, false); assert.equal("deleteAuditLog" in store, false); await assert.rejects(store.redactAuditLogPayloads(ctx, { workspaceId: "workspace-a" }), (error: RuleStoreError) => error.status === 403); assert.deepEqual(await store.redactAuditLogPayloads({ ...ctx, actorKind: "system" }, { workspaceId: "workspace-a" }), { count: 0 }); });
test("AI contexts are rejected from protected operations", () => { const ai = { workspaceId: "workspace-a", actorUserId: null }; for (const operation of ["approveRuleVersion", "addMember", "updateMemberRole", "removeMember", "createInvitation", "listInvitations", "updateInvitationStatus", "listMembers"]) assert.throws(() => requireHumanActor(ai, operation), RuleStoreError); for (const status of ["deprecated", "superseded", "archived"]) assert.throws(() => requireHumanActor(ai, "updateRuleStatus", status), RuleStoreError); const guarded = withHumanActorGuard("approveRuleVersion", (_ctx: RuleStoreContext) => "ok"); assert.throws(() => guarded(ai)); });
test("TypeScript and Python RuleStore method names and parameter ordering match", () => { const python = readFileSync(resolve(import.meta.dirname, "../../worker/src/rulebranch/rulestore.py"), "utf8"); const match = python.match(/RULE_STORE_METHOD_SIGNATURES = \(([^]*?)\n\)/); assert.ok(match); const pairs = [...match[1].matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((item) => [item[1], item[2]]); assert.deepEqual(pairs, RULE_STORE_METHOD_SIGNATURES); });
