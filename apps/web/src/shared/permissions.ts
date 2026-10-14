/** Central implementation of requirements.md 4.1 and 4.2. */
export const WORKSPACE_ROLES = ["owner", "admin", "maintainer", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type WorkspaceKind = "personal" | "organization";
export type RuleEnforcement = "locked" | "default" | "advisory" | "personal";
export type RuleScopeType = "organization" | "project" | "user" | "team";

const rank: Record<WorkspaceRole, number> = { viewer: 0, member: 1, maintainer: 2, admin: 3, owner: 4 };
export function hasRole(role: WorkspaceRole | null | undefined, minimum: WorkspaceRole): boolean {
  return role !== undefined && role !== null && rank[role] >= rank[minimum];
}
/** A personal workspace has exactly one owner, who has all Workspace operations. */
export function hasWorkspacePermission(kind: WorkspaceKind, role: WorkspaceRole | null | undefined, minimum: WorkspaceRole): boolean {
  return kind === "personal" ? role === "owner" : hasRole(role, minimum);
}
export function canApproveRuleVersion(input: { workspaceKind: WorkspaceKind; enforcement: RuleEnforcement; scopeType: RuleScopeType }, role: WorkspaceRole | null | undefined): boolean {
  if (input.workspaceKind === "personal") return role === "owner";
  if (input.enforcement === "locked") return hasRole(role, "admin");
  if (input.scopeType === "organization") return ["default", "advisory"].includes(input.enforcement) && hasRole(role, "admin");
  return (input.enforcement === "default" || input.enforcement === "advisory") && input.scopeType === "project" && hasRole(role, "maintainer");
}
export function canRestoreArchivedRule(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "admin"); }
export function canUninstall(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "admin"); }
export function canTransferWorkspace(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return kind === "personal" ? role === "owner" : role === "owner"; }
export function canTransferProject(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "admin"); }
export function canTriage(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "maintainer"); }
export function canRecompile(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "maintainer"); }
/** owner cannot be invited; ownership is granted only by owner-directed promotion. */
export function canInvite(inviter: WorkspaceRole | null | undefined, invitedRole: Exclude<WorkspaceRole, "owner">): boolean {
  if (inviter === "owner") return true;
  return inviter === "admin" && invitedRole !== "admin";
}
export function canChangeMemberRole(kind: WorkspaceKind, actor: WorkspaceRole | null | undefined, targetRole: WorkspaceRole): boolean {
  if (kind === "personal") return actor === "owner";
  return actor === "owner" || (actor === "admin" && !["owner", "admin"].includes(targetRole));
}
/** General guard for write endpoints which have no narrower matrix row yet. */
export function canWrite(kind: WorkspaceKind, role: WorkspaceRole | null | undefined): boolean { return hasWorkspacePermission(kind, role, "member"); }
