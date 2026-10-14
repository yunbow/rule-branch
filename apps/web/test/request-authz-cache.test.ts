import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceAccessReader, requireRole } from "../src/shared/authz.ts";
import { FirestoreRuleStore, RuleStoreError, type DocumentReferenceLike } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

class ReadCountingStore extends FirestoreRuleStore {
  reads = 0;
  override documentRef(collection: string, id: string): DocumentReferenceLike {
    const reference = super.documentRef(collection, id);
    return { id: reference.id, get: async () => { this.reads += 1; return reference.get(); } };
  }
}

function fixture() {
  const db = new InMemoryFirestore(), store = new ReadCountingStore(db);
  db.put("workspaces/w", { id: "w", kind: "organization", status: "active" });
  db.put("unique_keys/workspace_member:w:u", { id: "workspace_member:w:u", ownerWorkspaceId: "w", targetId: "m" });
  db.put("workspace_members/m", { id: "m", workspaceId: "w", userId: "u", role: "owner" });
  return { db, store };
}

test("one request reader deduplicates workspace, membership, and role reads", async () => {
  const { store } = fixture(), read = createWorkspaceAccessReader();
  const [first, second] = await Promise.all([read(store, "w", "u"), read(store, "w", "u")]);
  assert.strictEqual(first, second);
  assert.equal(first.role, "owner");
  assert.equal(store.reads, 3);
  assert.strictEqual(await read(store, "w", "u"), first);
  assert.equal(store.reads, 3);
});

test("authorization calls outside a Server Component request never retain stale roles", async () => {
  const { db, store } = fixture();
  assert.equal(await requireRole(store, "w", "u", "owner"), "owner");
  db.put("workspace_members/m", { id: "m", workspaceId: "w", userId: "u", role: "viewer" });
  await assert.rejects(requireRole(store, "w", "u", "owner"), (error: RuleStoreError) => error.code === "FORBIDDEN");
  db.put("workspaces/w", { id: "w", kind: "organization", status: "deleted", deletedAt: "2026-10-03" });
  await assert.rejects(requireRole(store, "w", "u", "viewer"), (error: RuleStoreError) => error.code === "NOT_FOUND");
});

test("a deleted membership is excluded from request access", async () => {
  const { db, store } = fixture(), read = createWorkspaceAccessReader();
  db.put("workspace_members/m", { id: "m", workspaceId: "w", userId: "u", role: "owner", deletedAt: "2026-10-03" });
  const access = await read(store, "w", "u");
  assert.equal(access.membership, null);
  assert.equal(access.role, null);
});
