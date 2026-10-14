import type { RuleStoreContext } from "./rulestore.ts";

export type AuditActor = { kind: "user" | "ai" | "system" | "github"; id: string };

/** Canonical identity used by services entered through an authenticated user request. */
export function userContext(workspaceId: string, userId: string | null): RuleStoreContext {
  return { workspaceId, actorUserId: userId, actorKind: "user" };
}

/** Keep audit-log actors consistent with the corresponding user request context. */
export function userActor(userId: string) {
  return { kind: "user" as const, id: userId };
}

/** Derive persisted ownership and audit identity from one execution context. */
export function auditActor(context: RuleStoreContext): AuditActor {
  return { kind: context.actorKind ?? "user", id: context.actorUserId ?? "system" };
}
