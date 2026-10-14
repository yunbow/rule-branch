"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarDays, Check, Clock3, LockKeyhole, MoreHorizontal, UserRound, X } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { canChangeMemberRole, hasRole, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { Dialog, DialogActions, useToast } from "../ui/index.tsx";

export type Member = {
  id: string;
  userId: string;
  role: WorkspaceRole;
  joinedVia?: string;
  createdAt?: string;
  user?: { login?: string; displayName?: string } | null;
};
export type PendingInvitation = {
  id: string;
  invitedGithubLogin: string;
  role: string;
  createdAt?: string;
  expiresAt: string;
};

const roles: WorkspaceRole[] = ["owner", "admin", "maintainer", "member", "viewer"];
const roleLabel: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  maintainer: "Maintainer",
  member: "Member",
  viewer: "Viewer",
};
const roleDescription: Record<WorkspaceRole, string> = {
  owner: "Workspace全体と所有権を管理",
  admin: "メンバー・設定を管理",
  maintainer: "ルール承認・Drift対応",
  member: "ルールの作成・編集",
  viewer: "閲覧のみ",
};
const joinedViaLabel: Record<string, string> = {
  personal_owner: "Workspace作成者",
  installer: "GitHub App連携",
  invitation: "招待から参加",
};

function initials(member: Member) {
  const source = member.user?.displayName || member.user?.login || member.userId;
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function RoleBadge({ role }: { role: WorkspaceRole | string }) {
  return <span className={`memberRoleBadge ${role}`}>{roleLabel[role as WorkspaceRole] ?? role}</span>;
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleDateString("ja-JP") : "—";
}

function daysUntil(value: string) {
  const diff = new Date(value).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

export function MemberTable({
  workspaceId,
  workspaceName,
  actorUserId,
  workspaceKind,
  actorRole,
  members,
  invitations,
}: {
  workspaceId: string;
  workspaceName: string;
  actorUserId: string;
  workspaceKind: WorkspaceKind;
  actorRole: WorkspaceRole;
  members: Member[];
  invitations: PendingInvitation[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "remove"; member: Member }
    | { kind: "revoke"; invitation: PendingInvitation }
    | null
  >(null);
  const owners = members.filter((member) => member.role === "owner").length;
  const canViewInvitations = hasRole(actorRole, "admin");

  const change = async (member: Member, role: WorkspaceRole) => {
    if (role === member.role) return;
    setBusy(member.id);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/members/${member.id}`, {
        method: "PATCH",
        body: { role },
      });
      toast.add("権限を変更しました");
      router.refresh();
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (member: Member) => {
    setBusy(member.id);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/members/${member.id}`, { method: "DELETE" });
      toast.add("メンバーをWorkspaceから削除しました");
      setConfirm(null);
      router.refresh();
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (invitation: PendingInvitation) => {
    setBusy(invitation.id);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`, { method: "POST" });
      toast.add("招待を取り消しました");
      setConfirm(null);
      router.refresh();
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="membersSection" aria-labelledby="workspace-members-heading">
      <div className="membersSectionHeader">
        <div>
          <p className="membersSectionKicker">MEMBERS</p>
          <h2 id="workspace-members-heading">参加中のメンバー <span>{members.length}</span></h2>
        </div>
        <details className="roleGuide">
          <summary>権限の違い</summary>
          <div>
            {roles.map((role) => <p key={role}><RoleBadge role={role}/><span>{roleDescription[role]}</span></p>)}
          </div>
        </details>
      </div>

      <div className="memberList">
        {members.map((member) => {
          const isYou = member.userId === actorUserId;
          const lastOwner = member.role === "owner" && owners === 1;
          const canManageTarget = canChangeMemberRole(workspaceKind, actorRole, member.role) && !lastOwner;
          const login = member.user?.login ?? member.userId;
          const displayName = member.user?.displayName;
          const joinedVia = member.joinedVia ? (joinedViaLabel[member.joinedVia] ?? member.joinedVia) : "参加経路不明";

          return <article className="memberRow" key={member.id}>
            <div className="memberIdentity">
              <span className="memberAvatar" aria-hidden="true">{initials(member)}</span>
              <div>
                <div className="memberNameLine">
                  <strong>{login}</strong>
                  {isYou && <span className="memberYouBadge">YOU</span>}
                </div>
                {displayName && displayName !== login && <span className="memberDisplayName">{displayName}</span>}
                <div className="memberMeta">
                  <span>{joinedVia}</span>
                  <span><CalendarDays size={12}/>{formatDate(member.createdAt)} 参加</span>
                </div>
              </div>
            </div>

            <div className="memberPermission">
              <RoleBadge role={member.role}/>
              <span>{roleDescription[member.role]}</span>
            </div>

            <div className="memberControls">
              <label className="memberRoleSelectLabel">
                <span>権限</span>
                <select
                  aria-label={`${login} の権限`}
                  value={member.role}
                  disabled={!canManageTarget || busy === member.id}
                  onChange={(event) => void change(member, event.target.value as WorkspaceRole)}
                >
                  {roles.map((candidate) => <option
                    key={candidate}
                    value={candidate}
                    disabled={(lastOwner && candidate !== "owner") || !canChangeMemberRole(workspaceKind, actorRole, candidate)}
                  >{roleLabel[candidate]}</option>)}
                </select>
              </label>

              {canManageTarget ? <details className="memberActionsMenu">
                <summary aria-label={`${login} の操作`}><MoreHorizontal size={18}/></summary>
                <div>
                  <button type="button" className="memberDangerAction" onClick={() => setConfirm({ kind: "remove", member })}>Workspaceから削除</button>
                </div>
              </details> : <span className="memberProtected" title={lastOwner ? "最後のOwnerは変更できません" : "このメンバーを変更する権限がありません"}>
                <LockKeyhole size={15}/>
              </span>}
            </div>
          </article>;
        })}
      </div>
    </section>

    {canViewInvitations && <section className="membersSection pendingInvitations" aria-labelledby="pending-invitations-heading">
      <div className="membersSectionHeader">
        <div>
          <p className="membersSectionKicker">PENDING INVITATIONS</p>
          <h2 id="pending-invitations-heading">保留中の招待 <span>{invitations.length}</span></h2>
        </div>
      </div>

      {invitations.length === 0 ? <div className="membersInlineEmpty"><Check size={17}/>保留中の招待はありません。</div> : <div className="invitationList">
        {invitations.map((invitation) => {
          const remaining = daysUntil(invitation.expiresAt);
          return <article className="invitationRow" key={invitation.id}>
            <div className="invitationIdentity">
              <span className="memberAvatar invitation"><UserRound size={17}/></span>
              <div>
                <strong>@{invitation.invitedGithubLogin}</strong>
                <div className="memberMeta">
                  <span><CalendarDays size={12}/>{formatDate(invitation.createdAt)} 招待</span>
                  <span className={remaining <= 2 ? "invitationExpiring" : ""}><Clock3 size={12}/>期限まで{remaining}日</span>
                </div>
              </div>
            </div>
            <div className="invitationRole"><RoleBadge role={invitation.role}/></div>
            <button
              type="button"
              className="invitationRevoke"
              disabled={busy === invitation.id}
              onClick={() => setConfirm({ kind: "revoke", invitation })}
            >招待を取り消す</button>
          </article>;
        })}
      </div>}
    </section>}

    {confirm?.kind === "remove" && <Dialog open onClose={() => setConfirm(null)}>
      <div className="memberConfirmDialog">
        <span className="memberConfirmIcon danger"><X size={20}/></span>
        <h2>Workspaceからメンバーを削除</h2>
        <p><strong>{confirm.member.user?.login ?? confirm.member.userId}</strong> を <strong>{workspaceName}</strong> から削除します。</p>
        <p>このユーザーはWorkspace内のルールやProjectへアクセスできなくなります。</p>
        <DialogActions
          className="memberDialogActions"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void remove(confirm.member)}
          confirmLabel="削除する"
          confirmVariant="danger"
          cancelVariant="ghost"
          loading={busy === confirm.member.id}
          cancelDisabled={false}
        />
      </div>
    </Dialog>}

    {confirm?.kind === "revoke" && <Dialog open onClose={() => setConfirm(null)}>
      <div className="memberConfirmDialog">
        <span className="memberConfirmIcon"><Clock3 size={20}/></span>
        <h2>招待を取り消す</h2>
        <p><strong>@{confirm.invitation.invitedGithubLogin}</strong> への招待を取り消します。</p>
        <p>必要になった場合は、あとからもう一度招待できます。</p>
        <DialogActions
          className="memberDialogActions"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void revoke(confirm.invitation)}
          confirmLabel="招待を取り消す"
          confirmVariant="danger"
          cancelVariant="ghost"
          loading={busy === confirm.invitation.id}
          cancelDisabled={false}
        />
      </div>
    </Dialog>}
  </>;
}
