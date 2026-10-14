import { cache } from "react";
import { FirestoreRuleStore, RuleStoreError } from "./rulestore.ts";
import type { DocumentData } from "./rulestore.ts";
import { hasRole, type WorkspaceRole } from "./permissions.ts";

export interface WorkspaceAccess {
  workspace: DocumentData | null;
  membership: DocumentData | null;
  role: WorkspaceRole | null;
  workspaceDeleted: boolean;
}

async function readWorkspaceAccess(store: FirestoreRuleStore, workspaceId: string, userId: string): Promise<WorkspaceAccess> {
  // Memberships are deliberately read by their unique key, not via tenant-wide lists.
  const [workspaceSnapshot, memberKey] = await Promise.all([
    store.documentRef("workspaces", workspaceId).get(),
    store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`).get(),
  ]);
  const workspace = workspaceSnapshot.data();
  if (workspaceSnapshot.exists && workspace && (workspace.status === "deleted" || workspace.deletedAt)) {
    return { workspace: null, membership: null, role: null, workspaceDeleted: true };
  }
  const targetId = memberKey.data()?.targetId;
  if (!memberKey.exists || typeof targetId !== "string") return { workspace: workspace ?? null, membership: null, role: null, workspaceDeleted: false };
  const memberSnapshot = await store.documentRef("workspace_members", targetId).get();
  const membership = memberSnapshot.data();
  if (!memberSnapshot.exists || !membership || membership.deletedAt) {
    return { workspace: workspace ?? null, membership: null, role: null, workspaceDeleted: false };
  }
  const role = membership.role as WorkspaceRole | undefined;
  return { workspace: workspace ?? null, membership, role: role ?? null, workspaceDeleted: false };
}

/**
 * Creates a cache owned by one render request. Rejected reads are evicted so a
 * transient Firestore error can be retried during the same render.
 */
export function createWorkspaceAccessReader() {
  const byStore = new WeakMap<FirestoreRuleStore, Map<string, Promise<WorkspaceAccess>>>();
  return (store: FirestoreRuleStore, workspaceId: string, userId: string): Promise<WorkspaceAccess> => {
    let entries = byStore.get(store);
    if (!entries) { entries = new Map(); byStore.set(store, entries); }
    const key = JSON.stringify([workspaceId, userId]);
    const existing = entries.get(key);
    if (existing) return existing;
    const pending = readWorkspaceAccess(store, workspaceId, userId).catch((error: unknown) => {
      if (entries!.get(key) === pending) entries!.delete(key);
      throw error;
    });
    entries.set(key, pending);
    return pending;
  };
}

// React owns this value for a single Server Component render request. Outside
// that dispatcher (including route-handler calls), cache() does not retain it.
const getRequestWorkspaceAccessReader = cache(createWorkspaceAccessReader);

export function getRequestWorkspaceAccess(store: FirestoreRuleStore, workspaceId: string, userId: string): Promise<WorkspaceAccess> {
  return getRequestWorkspaceAccessReader()(store, workspaceId, userId);
}

export async function requireRole(store: FirestoreRuleStore, workspaceId: string, userId: string | null, minRole: WorkspaceRole): Promise<WorkspaceRole> {
  if (!userId) throw new RuleStoreError("UNAUTHENTICATED", 401);
  const access = await getRequestWorkspaceAccess(store, workspaceId, userId);
  if (access.workspaceDeleted) throw new RuleStoreError("NOT_FOUND", 404, { workspaceId });
  const role = access.role ?? undefined;
  if (!role || !hasRole(role, minRole)) throw new RuleStoreError("FORBIDDEN", 403, { workspaceId, minRole });
  return role;
}
