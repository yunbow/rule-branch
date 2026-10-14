import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, RuleStoreError, type DocumentData } from "./rulestore.ts";
import { TRANSFER_POLICY_PROHIBITED } from "./auth.ts";
import { userActor, userContext } from "./service-context.ts";
export const USER_PREFERENCE_MUTABLE_FIELDS = ["locale", "explanationLevel", "reviewDisplay"] as const;
export type UserPreferencePatch = Partial<Pick<UserPreferences, (typeof USER_PREFERENCE_MUTABLE_FIELDS)[number]>> & { notifications?: never };
export interface UserPreferences extends DocumentData { id: string; userId: string; locale: string; explanationLevel: "brief" | "normal" | "detailed"; reviewDisplay: Record<string, unknown>; notifications: Record<string, never>; transferPolicy: typeof TRANSFER_POLICY_PROHIBITED; }
export class UserPreferencesService {
  private readonly store: FirestoreRuleStore;
  constructor(store: FirestoreRuleStore) { this.store = store; }
  async get(userId: string): Promise<UserPreferences> { const key = await this.store.documentRef("unique_keys", `user_preference:${userId}`).get(); if (!key.exists) throw new RuleStoreError("NOT_FOUND", 404); const preference = await this.store.documentRef("user_preferences", key.data()!.targetId as string).get(); if (!preference.exists) throw new RuleStoreError("NOT_FOUND", 404); return preference.data() as UserPreferences; }
  async update(userId: string, patch: Record<string, unknown>, requestId = `preferences:${generateUlid()}`): Promise<UserPreferences> {
    if ("notifications" in patch) throw new RuleStoreError("NOTIFICATIONS_UNSUPPORTED", 422);
    const unknown = Object.keys(patch).filter((key) => !USER_PREFERENCE_MUTABLE_FIELDS.includes(key as (typeof USER_PREFERENCE_MUTABLE_FIELDS)[number])); if (unknown.length) throw new RuleStoreError("INVALID_PREFERENCE_FIELD", 422, { fields: unknown });
    if (patch.explanationLevel !== undefined && !["brief", "normal", "detailed"].includes(String(patch.explanationLevel))) throw new RuleStoreError("INVALID_EXPLANATION_LEVEL", 422);
    return this.store.runTransaction(async (tx) => { const key = await tx.get(this.store.documentRef("unique_keys", `user_preference:${userId}`)); if (!key.exists) throw new RuleStoreError("NOT_FOUND", 404); const ref = this.store.documentRef("user_preferences", key.data()!.targetId as string); const snapshot = await tx.get(ref); if (!snapshot.exists) throw new RuleStoreError("NOT_FOUND", 404); const user = await tx.get(this.store.documentRef("users", userId)); const workspaceId = user.data()?.personalWorkspaceId as string | undefined; if (!workspaceId) throw new RuleStoreError("NOT_FOUND", 404); const before = snapshot.data() as UserPreferences; const after = { ...before, ...patch, notifications: {}, transferPolicy: TRANSFER_POLICY_PROHIBITED } as UserPreferences; tx.update(ref, after); await this.store.appendAuditLog(userContext(workspaceId, userId), { actor: userActor(userId), action: "user_preferences.update", targetType: "user_preferences", targetId: before.id, requestId, before, after }, tx); return after; });
  }
}
