import assert from "node:assert/strict";
import test from "node:test";
import { DriftService } from "../src/shared/drift.ts";
import { FirestoreRuleStore, RuleStoreError } from "../src/shared/rulestore.ts";
import { UserPreferencesService } from "../src/shared/user-preferences.ts";
import { WorkspaceInvitationsService } from "../src/shared/workspace-invitations.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const documents = (db: InMemoryFirestore, collection: string) => db.query(collection, []).map((snapshot) => snapshot.data()!);
const put = (db: InMemoryFirestore, collection: string, id: string, data: Record<string, unknown>) => db.put(`${collection}/${id}`, { id, ...data });

test("rule approval keeps one current approved version and obeys Firestore read-before-write ordering", async () => {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), store = new FirestoreRuleStore(db), ctx = { workspaceId: "w", actorUserId: "u" };
  put(db, "rules", "r", { ownerWorkspaceId: "w", title: "Rule", status: "active", currentVersionId: null });
  for (const [id, version] of [["v1", 1], ["v2", 2]] as const) put(db, "rule_versions", id, { ownerWorkspaceId: "w", ruleId: "r", version, status: "proposed", driftFindingIds: [], evidenceIds: [], rationale: id, changeType: "clarify" });

  await Promise.all([store.approveRuleVersion(ctx, "v1"), store.approveRuleVersion(ctx, "v2")]);

  const rule = (await store.get(ctx, "rules", "r"))!, versions = documents(db, "rule_versions");
  assert.equal(versions.filter((version) => version.status === "approved").length, 1);
  assert.equal(versions.filter((version) => version.status === "superseded").length, 1);
  assert.equal(versions.find((version) => version.status === "approved")!.id, rule.currentVersionId);
});

test("expired invitation acceptance commits expiry and frees its reservation before returning 422", async () => {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), store = new FirestoreRuleStore(db), now = new Date("2026-09-20T00:00:00Z");
  put(db, "users", "u", { githubUserId: "7" });
  put(db, "workspace_invitations", "i", { workspaceId: "w", invitedGithubUserId: "7", status: "pending", expiresAt: "2026-09-19T00:00:00Z" });
  put(db, "unique_keys", "workspace_invitation_pending:w:7", { kind: "workspace_invitation_pending", ownerWorkspaceId: "w", targetId: "i" });
  const service = new WorkspaceInvitationsService(store, { getUserByLogin: async () => null }, () => now);

  await assert.rejects(service.acceptInvitation("u", "i"), (error: RuleStoreError) => error.code === "INVITATION_EXPIRED");

  assert.equal(documents(db, "workspace_invitations")[0]!.status, "expired");
  assert.equal(documents(db, "unique_keys").length, 0);
  assert.equal(documents(db, "workspace_members").length, 0);
});

test("triage and preference updates keep all transaction reads ahead of writes", async () => {
  const db = new InMemoryFirestore({ enforceReadBeforeWrite: true }), store = new FirestoreRuleStore(db);
  put(db, "workspace_members", "m", { workspaceId: "w", userId: "u", role: "maintainer" });
  put(db, "unique_keys", "workspace_member:w:u", { targetId: "m", ownerWorkspaceId: "w" });
  put(db, "rules", "r", { ownerWorkspaceId: "w", status: "stale", staleSince: "before" });
  put(db, "drift_findings", "f", { ownerWorkspaceId: "w", ruleId: "r", status: "open", reopenCount: 0 });
  await new DriftService(store).triage("w", "u", "f", "dismiss", "obsolete");
  assert.equal((await store.get({ workspaceId: "w", actorUserId: "u" }, "rules", "r"))!.status, "active");

  put(db, "users", "u", { personalWorkspaceId: "w" });
  put(db, "user_preferences", "p", { userId: "u", locale: "ja", explanationLevel: "normal", reviewDisplay: {}, notifications: {}, transferPolicy: "prohibited" });
  put(db, "unique_keys", "user_preference:u", { targetId: "p", ownerWorkspaceId: null });
  const preference = await new UserPreferencesService(store).update("u", { explanationLevel: "detailed" });
  assert.equal(preference.explanationLevel, "detailed");
});
