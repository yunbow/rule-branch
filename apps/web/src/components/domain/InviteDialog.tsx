"use client";

import { useState } from "react";
import { AtSign, ShieldCheck, UserPlus } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { canInvite, type WorkspaceRole } from "../../shared/permissions.ts";
import { Dialog, DialogActions, TextArea, useToast } from "../ui/index.tsx";

const roles: Exclude<WorkspaceRole, "owner">[] = ["admin", "maintainer", "member", "viewer"];
const roleLabel: Record<Exclude<WorkspaceRole, "owner">, string> = {
  admin: "Admin",
  maintainer: "Maintainer",
  member: "Member",
  viewer: "Viewer",
};
const roleDescription: Record<Exclude<WorkspaceRole, "owner">, string> = {
  admin: "メンバー・設定を管理できます。",
  maintainer: "ルール承認やDrift対応ができます。",
  member: "ルールの作成・編集ができます。",
  viewer: "Workspaceを閲覧できます。",
};

export function InviteDialog({ workspaceId, role, onClose, onInvited }: {
  workspaceId: string;
  role: WorkspaceRole;
  onClose: () => void;
  onInvited?: () => void;
}) {
  const toast = useToast();
  const [githubLogin, setGithubLogin] = useState("");
  const [invitedRole, setInvitedRole] = useState<Exclude<WorkspaceRole, "owner">>(role === "admin" ? "maintainer" : "member");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        body: { githubLogin: githubLogin.replace(/^@/, "").trim(), role: invitedRole, message: message || null },
      });
      toast.add("招待を送信しました");
      onClose();
      onInvited?.();
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
    } finally {
      setSaving(false);
    }
  };

  const availableRoles = roles.filter((candidate) => canInvite(role, candidate));

  return <Dialog open onClose={onClose}>
    <form className="inviteMemberDialog" onSubmit={submit}>
      <div className="inviteDialogHeader">
        <span className="inviteDialogIcon"><UserPlus size={20}/></span>
        <div>
          <p>INVITE MEMBER</p>
          <h2>メンバーを招待</h2>
          <span>GitHubユーザーをWorkspaceへ招待します。</span>
        </div>
      </div>

      <label className="inviteField">
        <span>GitHubユーザー</span>
        <div className="inviteGithubInput">
          <AtSign size={15}/>
          <input
            value={githubLogin}
            onChange={(event) => setGithubLogin(event.target.value)}
            placeholder="octocat"
            autoComplete="off"
            required
          />
        </div>
      </label>

      <fieldset className="inviteRoleFieldset">
        <legend>権限</legend>
        <div className="inviteRoleOptions">
          {availableRoles.map((candidate) => <label className={invitedRole === candidate ? "selected" : ""} key={candidate}>
            <input
              type="radio"
              name="role"
              value={candidate}
              checked={invitedRole === candidate}
              onChange={() => setInvitedRole(candidate)}
            />
            <span className="inviteRoleIcon"><ShieldCheck size={15}/></span>
            <span>
              <strong>{roleLabel[candidate]}</strong>
              <small>{roleDescription[candidate]}</small>
            </span>
          </label>)}
        </div>
      </fieldset>

      <div className="inviteMessageField">
        <TextArea
          label="メッセージ（任意）"
          maxLength={500}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="招待の目的や補足があれば入力してください"
        />
      </div>

      <DialogActions
        className="inviteDialogActions"
        onCancel={onClose}
        confirmLabel="招待を送信"
        confirmType="submit"
        cancelVariant="ghost"
        loading={saving}
        cancelDisabled={false}
      />
    </form>
  </Dialog>;
}
