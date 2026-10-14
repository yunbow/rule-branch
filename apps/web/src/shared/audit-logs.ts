import { requireRole } from "./authz.ts";
import { RuleStoreError, type FirestoreRuleStore, type DocumentData } from "./rulestore.ts";
import { userContext } from "./service-context.ts";

export type AuditLogView = Pick<DocumentData, "id" | "actor" | "action" | "targetType" | "targetId" | "occurredAt" | "requestId" | "before" | "after" | "payloadRedactedAt">;
export type AuditLogPage = { entries: AuditLogView[]; nextCursor: string | null };

/** Bounded, admin-only tenant reads. Snapshot cursors preserve records sharing a timestamp. */
export async function listAuditLogs(store: FirestoreRuleStore, workspaceId: string, userId: string | null,
  options: { limit?: number; cursor?: string } = {}): Promise<AuditLogPage> {
  await requireRole(store, workspaceId, userId, "admin");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RuleStoreError("INVALID_QUERY_LIMIT", 422);
  const ctx = userContext(workspaceId, userId);
  let snapshot;
  if (options.cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.cursor)) throw new RuleStoreError("INVALID_QUERY_CURSOR", 422);
    snapshot = await store.documentRef("audit_logs", options.cursor).get();
    const data = snapshot.data();
    if (!snapshot.exists || !data || data.ownerWorkspaceId !== workspaceId || data.deletedAt || typeof data.occurredAt !== "string") {
      throw new RuleStoreError("INVALID_QUERY_CURSOR", 422);
    }
  }
  const records = await store.listQuery(ctx, "audit_logs", [], {
    orderBy: { field: "occurredAt", direction: "desc" }, limit: limit + 1, startAfter: snapshot,
  });
  const entries = records.slice(0, limit).map(({ id, actor, action, targetType, targetId, occurredAt, requestId, before, after, payloadRedactedAt }) =>
    ({ id, actor, action, targetType, targetId, occurredAt, requestId, before: before ?? null, after: after ?? null, payloadRedactedAt: payloadRedactedAt ?? null }));
  return { entries, nextCursor: records.length > limit ? String(entries.at(-1)!.id) : null };
}
