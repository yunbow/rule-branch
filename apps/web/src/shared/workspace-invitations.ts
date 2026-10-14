import { LIMITS } from "./contracts.ts";
import { requireRole } from "./authz.ts";
import { canChangeMemberRole, canInvite, hasRole, type WorkspaceRole } from "./permissions.ts";
import { FirestoreRuleStore, requireHumanActor, RuleStoreError, type DocumentData } from "./rulestore.ts";
import { generateUlid } from "./ulid.ts";
import { userActor, userContext } from "./service-context.ts";

/** Public GitHub lookup is kept behind this small port so tests never call GitHub. */
export interface GitHubUserLookupClient { getUserByLogin(login: string): Promise<{ id: string | number; login: string } | null>; }
export interface InvitationInput { githubLogin: string; role: Exclude<WorkspaceRole, "owner">; message?: string | null; requestId?: string; }
const INVITABLE_ROLES = new Set<InvitationInput["role"]>(["admin", "maintainer", "member", "viewer"]);
const expiryDays = (LIMITS.invitations as { expiryDays: number }).expiryDays;

function invitationKey(workspaceId: string, githubUserId: string) { return { workspaceId, invitedGithubUserId: githubUserId }; }
function asDate(value: unknown) { return new Date(String(value)); }

export class WorkspaceInvitationsService {
  readonly store: FirestoreRuleStore;
  private readonly github: GitHubUserLookupClient;
  private readonly clock: () => Date;
  constructor(store: FirestoreRuleStore, github: GitHubUserLookupClient, clock: () => Date = () => new Date()) { this.store = store; this.github = github; this.clock = clock; }
  private now() { return this.clock().toISOString(); }
  private async workspace(workspaceId: string): Promise<DocumentData> { const snapshot = await this.store.documentRef("workspaces", workspaceId).get(); if (!snapshot.exists || !snapshot.data()) throw new RuleStoreError("NOT_FOUND", 404); return snapshot.data()!; }
  private ctx(workspaceId: string, actorUserId: string | null) { return userContext(workspaceId, actorUserId); }

  async createInvitation(workspaceId: string, actorUserId: string | null, input: InvitationInput): Promise<DocumentData> {
    const ctx = this.ctx(workspaceId, actorUserId); requireHumanActor(ctx, "createInvitation");
    if (typeof input.githubLogin !== "string" || !input.githubLogin.trim()) throw new RuleStoreError("INVALID_GITHUB_LOGIN", 422);
    if (!INVITABLE_ROLES.has(input.role)) throw new RuleStoreError("INVALID_INVITATION_ROLE", 422);
    if (input.message != null && (typeof input.message !== "string" || [...input.message].length > 500)) throw new RuleStoreError("INVITATION_MESSAGE_TOO_LONG", 422);
    const workspace = await this.workspace(workspaceId); if (workspace.kind === "personal") throw new RuleStoreError("PERSONAL_WORKSPACE_INVITATION_FORBIDDEN", 422);
    const inviterRole = await requireRole(this.store, workspaceId, actorUserId, "admin");
    if (!canInvite(inviterRole, input.role)) throw new RuleStoreError("FORBIDDEN", 403);
    const githubUser = await this.github.getUserByLogin(input.githubLogin.trim()); if (!githubUser) throw new RuleStoreError("GITHUB_USER_NOT_FOUND", 422);
    const invitedGithubUserId = String(githubUser.id), login = githubUser.login.toLowerCase(), now = this.now(), expiresAt = new Date(this.clock().getTime() + expiryDays * 86_400_000).toISOString(), id = generateUlid();
    return this.store.runTransaction(async (tx) => {
      const key = invitationKey(workspaceId, invitedGithubUserId), keyRef = this.store.documentRef("unique_keys", `workspace_invitation_pending:${workspaceId}:${invitedGithubUserId}`), existing = await tx.get(keyRef);
      let replaced: DocumentData | undefined;
      if (existing.exists) {
        const oldRef = this.store.documentRef("workspace_invitations", existing.data()!.targetId as string), old = await tx.get(oldRef);
        if (!old.exists || !old.data() || old.data()!.status !== "pending") throw new RuleStoreError("INVITATION_PENDING_KEY_INVALID", 409);
        if (asDate(old.data()!.expiresAt).getTime() > this.clock().getTime()) throw new RuleStoreError("INVITATION_ALREADY_PENDING", 409);
        replaced = old.data()!; tx.update(oldRef, { status: "expired", updatedAt: now });
        await this.store.appendAuditLog(ctx, { actor: userActor(actorUserId!), action: "workspace.invite_expire", targetType: "workspace_invitations", targetId: old.id, requestId: input.requestId ?? `invite:${id}`, before: { status: "pending" }, after: { status: "expired" } }, tx);
      }
      const invitation: DocumentData = { id, workspaceId, invitedGithubLogin: login, invitedGithubUserId, role: input.role, status: "pending", message: input.message ?? null, invitedByUserId: actorUserId, expiresAt, acceptedByUserId: null, acceptedAt: null, revokedAt: null, createdAt: now, updatedAt: now };
      // An expired reservation is released and re-reserved atomically by retargeting
      // its reservation document in this transaction; no non-pending invitation owns it.
      if (replaced) tx.update(keyRef, { targetTable: "workspace_invitations", targetId: id, createdAt: now });
      else await this.store.reserveUniqueKey(tx, "workspace_invitation_pending", key, { targetTable: "workspace_invitations", targetId: id });
      tx.create(this.store.documentRef("workspace_invitations", id), invitation);
      await this.store.appendAuditLog(ctx, { actor: userActor(actorUserId!), action: "workspace.invite", targetType: "workspace_invitations", targetId: id, requestId: input.requestId ?? `invite:${id}`, after: { githubUserId: invitedGithubUserId, role: input.role, replacedInvitationId: replaced?.id ?? null } }, tx);
      return invitation;
    });
  }

  private async expire(invitation: DocumentData, ctx: { workspaceId: string; actorUserId: string | null; actorKind?: "user" | "ai" | "system" | "github" }, requestId: string): Promise<boolean> {
    if (invitation.status !== "pending" || asDate(invitation.expiresAt).getTime() > this.clock().getTime()) return false;
    return this.store.runTransaction(async (tx) => { const ref = this.store.documentRef("workspace_invitations", invitation.id as string), current = await tx.get(ref), data = current.data(); if (!current.exists || !data || data.status !== "pending" || asDate(data.expiresAt).getTime() > this.clock().getTime()) return false; const now = this.now(); tx.update(ref, { status: "expired", updatedAt: now }); await this.store.releaseUniqueKey(tx, "workspace_invitation_pending", invitationKey(data.workspaceId as string, data.invitedGithubUserId as string)); return true; });
  }

  async listMyInvitations(userId: string | null): Promise<DocumentData[]> {
    const ctx = this.ctx("_me", userId); requireHumanActor(ctx, "listInvitations");
    const user = await this.store.documentRef("users", userId!).get(); if (!user.exists || !user.data()) throw new RuleStoreError("UNAUTHENTICATED", 401);
    const pending = (await this.store.findServerDocuments("workspace_invitations", { invitedGithubUserId: String(user.data()!.githubUserId), status: "pending" }));
    await Promise.all(pending.map((item) => this.expire(item, { workspaceId: item.workspaceId as string, actorUserId: userId }, `invitation-expire:${item.id}`)));
    const current = await this.store.findServerDocuments("workspace_invitations", { invitedGithubUserId: String(user.data()!.githubUserId), status: "pending" });
    const inviterIds = [...new Set(current.map((item) => typeof item.invitedByUserId === "string" ? item.invitedByUserId : "").filter(Boolean))];
    const [workspaces, inviters] = await Promise.all([
      this.store.getServerDocuments("workspaces", current.map((item) => String(item.workspaceId))),
      this.store.getServerDocuments("users", inviterIds),
    ]);
    const workspacesById = new Map(workspaces.map((workspace) => [String(workspace.id), workspace]));
    const invitersById = new Map(inviters.map((inviter) => [String(inviter.id), inviter]));
    return current.map((item) => {
      const workspace = workspacesById.get(String(item.workspaceId));
      const inviter = typeof item.invitedByUserId === "string" ? invitersById.get(item.invitedByUserId) : undefined;
      return {
        ...item,
        workspace: workspace ? { name: workspace.name } : null,
        invitedBy: inviter ? { login: inviter.login, displayName: inviter.displayName } : null,
      };
    });
  }

  async acceptInvitation(userId: string | null, invitationId: string, requestId = `invite-accept:${invitationId}`): Promise<DocumentData> {
    const ctx = this.ctx("_me", userId); requireHumanActor(ctx, "updateInvitationStatus");
    const result = await this.store.runTransaction(async (tx) => {
      const user = await tx.get(this.store.documentRef("users", userId!)), ref = this.store.documentRef("workspace_invitations", invitationId), snapshot = await tx.get(ref), invitation = snapshot.data();
      if (!user.exists || !user.data()) throw new RuleStoreError("UNAUTHENTICATED", 401); if (!snapshot.exists || !invitation || String(invitation.invitedGithubUserId) !== String(user.data()!.githubUserId)) throw new RuleStoreError("NOT_FOUND", 404);
      if (invitation.status !== "pending") throw new RuleStoreError("INVITATION_NOT_PENDING", 422); const now = this.now(); if (asDate(invitation.expiresAt).getTime() <= this.clock().getTime()) { tx.update(ref, { status: "expired", updatedAt: now }); await this.store.releaseUniqueKey(tx, "workspace_invitation_pending", invitationKey(invitation.workspaceId as string, invitation.invitedGithubUserId as string)); return null; }
      const memberId = generateUlid(), memberKey = { workspaceId: invitation.workspaceId as string, userId: userId! }; await this.store.reserveUniqueKey(tx, "workspace_member", memberKey, { targetTable: "workspace_members", targetId: memberId });
      const member: DocumentData = { id: memberId, workspaceId: invitation.workspaceId, userId, role: invitation.role, invitedByUserId: invitation.invitedByUserId, joinedVia: "invitation", invitationId, createdAt: now, updatedAt: now }; tx.create(this.store.documentRef("workspace_members", memberId), member); tx.update(ref, { status: "accepted", acceptedByUserId: userId, acceptedAt: now, updatedAt: now }); await this.store.releaseUniqueKey(tx, "workspace_invitation_pending", invitationKey(invitation.workspaceId as string, invitation.invitedGithubUserId as string));
      await this.store.appendAuditLog(userContext(invitation.workspaceId as string, userId), { actor: userActor(userId!), action: "workspace.invite_accept", targetType: "workspace_invitations", targetId: invitationId, requestId, after: { memberId } }, tx); return member;
    });
    if (!result) throw new RuleStoreError("INVITATION_EXPIRED", 422);
    return result;
  }

  private async transitionForInvitee(userId: string | null, invitationId: string, status: "declined", requestId: string): Promise<DocumentData> {
    const ctx = this.ctx("_me", userId); requireHumanActor(ctx, "updateInvitationStatus"); return this.store.runTransaction(async (tx) => { const user = await tx.get(this.store.documentRef("users", userId!)), ref = this.store.documentRef("workspace_invitations", invitationId), snapshot = await tx.get(ref), invitation = snapshot.data(); if (!user.exists || !user.data()) throw new RuleStoreError("UNAUTHENTICATED", 401); if (!snapshot.exists || !invitation || String(invitation.invitedGithubUserId) !== String(user.data()!.githubUserId)) throw new RuleStoreError("NOT_FOUND", 404); if (invitation.status !== "pending") throw new RuleStoreError("INVITATION_NOT_PENDING", 422); const now = this.now(); tx.update(ref, { status, updatedAt: now }); await this.store.releaseUniqueKey(tx, "workspace_invitation_pending", invitationKey(invitation.workspaceId as string, invitation.invitedGithubUserId as string)); await this.store.appendAuditLog(userContext(invitation.workspaceId as string, userId), { actor: userActor(userId!), action: "workspace.invite_decline", targetType: "workspace_invitations", targetId: invitationId, requestId, before: { status: "pending" }, after: { status } }, tx); return { ...invitation, status, updatedAt: now }; });
  }
  declineInvitation(userId: string | null, invitationId: string, requestId = `invite-decline:${invitationId}`) { return this.transitionForInvitee(userId, invitationId, "declined", requestId); }

  async revokeInvitation(workspaceId: string, actorUserId: string | null, invitationId: string, requestId = `invite-revoke:${invitationId}`): Promise<DocumentData> {
    const ctx = this.ctx(workspaceId, actorUserId); requireHumanActor(ctx, "updateInvitationStatus"); await requireRole(this.store, workspaceId, actorUserId, "admin"); return this.store.runTransaction(async (tx) => { const ref = this.store.documentRef("workspace_invitations", invitationId), snapshot = await tx.get(ref), invitation = snapshot.data(); if (!snapshot.exists || !invitation || invitation.workspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404); if (invitation.status !== "pending") throw new RuleStoreError("INVITATION_NOT_PENDING", 422); const now = this.now(); tx.update(ref, { status: "revoked", revokedAt: now, updatedAt: now }); await this.store.releaseUniqueKey(tx, "workspace_invitation_pending", invitationKey(workspaceId, invitation.invitedGithubUserId as string)); await this.store.appendAuditLog(ctx, { actor: userActor(actorUserId!), action: "workspace.invite_revoke", targetType: "workspace_invitations", targetId: invitationId, requestId, before: { status: "pending" }, after: { status: "revoked" } }, tx); return { ...invitation, status: "revoked", revokedAt: now, updatedAt: now }; });
  }

  async listPendingInvitations(workspaceId: string, actorUserId: string | null): Promise<DocumentData[]> {
    const ctx = this.ctx(workspaceId, actorUserId); requireHumanActor(ctx, "listPendingInvitations"); await requireRole(this.store, workspaceId, actorUserId, "admin");
    const pending = await this.store.findServerDocuments("workspace_invitations", { workspaceId, status: "pending" });
    await Promise.all(pending.map((item) => this.expire(item, ctx, `invitation-expire:${item.id}`)));
    return (await this.store.findServerDocuments("workspace_invitations", { workspaceId, status: "pending" })).map((item) => ({ ...item }));
  }

  async listMembers(workspaceId: string, actorUserId: string | null): Promise<DocumentData[]> {
    const ctx = this.ctx(workspaceId, actorUserId); requireHumanActor(ctx, "listMembers"); await requireRole(this.store, workspaceId, actorUserId, "viewer");
    const members = await this.store.findServerDocuments("workspace_members", { workspaceId });
    const users = await this.store.getServerDocuments("users", members.map((member) => String(member.userId)));
    const usersById = new Map(users.map((user) => [String(user.id), user]));
    return members.map((member) => { const user = usersById.get(String(member.userId)); return { ...member, user: user ? { login: user.login, displayName: user.displayName } : null }; });
  }
  private async memberOperation(workspaceId: string, actorUserId: string | null, memberId: string, action: "change_role" | "remove", role: WorkspaceRole | undefined, requestId: string): Promise<DocumentData> {
    const ctx = this.ctx(workspaceId, actorUserId); requireHumanActor(ctx, action === "change_role" ? "updateMemberRole" : "removeMember");
    if (!actorUserId) throw new RuleStoreError("UNAUTHENTICATED", 401);
    if (action === "change_role" && (typeof role !== "string" || !["owner", "admin", "maintainer", "member", "viewer"].includes(role))) throw new RuleStoreError("INVALID_WORKSPACE_ROLE", 422);
    if (action === "remove" && role !== undefined) throw new RuleStoreError("INVALID_WORKSPACE_ROLE", 422);
    return this.store.runTransaction(async (tx) => {
      // Updating this shared document serializes membership changes.  The owner
      // count is a query (Firestore's transaction interface cannot query here),
      // so without this write two concurrent demotions could both observe two
      // owners and commit an ownerless Workspace.
      const workspaceRef = this.store.documentRef("workspaces", workspaceId);
      const [workspaceSnapshot, actorKey, snapshot] = await Promise.all([
        tx.get(workspaceRef),
        tx.get(this.store.documentRef("unique_keys", `workspace_member:${workspaceId}:${actorUserId}`)),
        tx.get(this.store.documentRef("workspace_members", memberId)),
      ]);
      const workspace = workspaceSnapshot.data(), member = snapshot.data();
      if (!workspaceSnapshot.exists || !workspace) throw new RuleStoreError("NOT_FOUND", 404);
      if (!snapshot.exists || !member || member.workspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      const actorMembership = actorKey.exists ? await tx.get(this.store.documentRef("workspace_members", String(actorKey.data()?.targetId ?? ""))) : null;
      const actorRole = actorMembership?.data()?.role as WorkspaceRole | undefined;
      if (!actorMembership?.exists || !hasRole(actorRole, "admin")) throw new RuleStoreError("FORBIDDEN", 403);
      if (action === "change_role" ? !canChangeMemberRole(workspace.kind as "personal" | "organization", actorRole, role as WorkspaceRole) : !canChangeMemberRole(workspace.kind as "personal" | "organization", actorRole, member.role as WorkspaceRole)) throw new RuleStoreError("FORBIDDEN", 403);
      // The target's current role matters for demotion as well as removal.
      // Otherwise an admin can demote a peer/owner to viewer and then remove them.
      if (actorRole === "admin" && (member.role === "owner" || member.role === "admin")) throw new RuleStoreError("FORBIDDEN", 403);
      if (member.role === "owner" && role !== "owner") {
        const owners = await this.store.findServerDocuments("workspace_members", { workspaceId, role: "owner" });
        if (owners.length <= 1) throw new RuleStoreError("LAST_OWNER_REQUIRED", 422);
      }
      const now = this.now();
      // A removed member must not be silently re-added through the GitHub App
      // installer path, regardless of how they originally joined. Persist on
      // the Workspace because the membership document itself is removed.
      const revoked = action === "remove"
        ? { revokedInstallerUserIds: [...new Set([...(Array.isArray(workspace.revokedInstallerUserIds) ? workspace.revokedInstallerUserIds as string[] : []), String(member.userId)])] }
        : {};
      tx.update(workspaceRef, { updatedAt: now, ...revoked });
      if (action === "change_role") { tx.update(this.store.documentRef("workspace_members", memberId), { role, updatedAt: now }); await this.store.appendAuditLog(ctx, { actor: userActor(actorUserId), action: "workspace.member_role_change", targetType: "workspace_members", targetId: memberId, requestId, before: { role: member.role }, after: { role } }, tx); return { ...member, role, updatedAt: now }; }
      await this.store.releaseUniqueKey(tx, "workspace_member", { workspaceId, userId: member.userId as string }); tx.delete(this.store.documentRef("workspace_members", memberId)); await this.store.appendAuditLog(ctx, { actor: userActor(actorUserId), action: "workspace.member_remove", targetType: "workspace_members", targetId: memberId, requestId, before: { userId: member.userId, role: member.role } }, tx); return member;
    });
  }
  updateMemberRole(workspaceId: string, actorUserId: string | null, memberId: string, role: WorkspaceRole, requestId = `member-role:${memberId}`) { return this.memberOperation(workspaceId, actorUserId, memberId, "change_role", role, requestId); }
  removeMember(workspaceId: string, actorUserId: string | null, memberId: string, requestId = `member-remove:${memberId}`) { return this.memberOperation(workspaceId, actorUserId, memberId, "remove", undefined, requestId); }
}
