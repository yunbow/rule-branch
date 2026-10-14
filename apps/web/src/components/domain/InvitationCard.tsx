"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Building2, Clock3, MessageSquareQuote, ShieldCheck, UserRound } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { Button, Dialog, DialogActions, useToast } from "../ui/index.tsx";

export type Invitation = {
  id: string;
  workspaceId: string;
  workspace?: { name?: string } | null;
  role: string;
  message?: string | null;
  invitedByUserId?: string;
  invitedBy?: { login?: string; displayName?: string } | null;
  createdAt?: string;
  expiresAt: string;
};

const roleLabel: Record<string, string> = {
  admin: "Admin",
  maintainer: "Maintainer",
  member: "Member",
  viewer: "Viewer",
};

const roleDescription: Record<string, string> = {
  admin: "メンバー・Workspace設定を管理できます。",
  maintainer: "ルール承認やDrift対応ができます。",
  member: "ルールの作成・編集ができます。",
  viewer: "Workspaceを閲覧できます。",
};

function remainingDays(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

function expiryLabel(expiresAt: string) {
  const days = remainingDays(expiresAt);
  if (days === 0) return "今日まで";
  if (days === 1) return "あと1日";
  return `あと${days}日`;
}

export function InvitationCard({ invitation }: { invitation: Invitation }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);

  const workspaceName = invitation.workspace?.name ?? "Workspace";
  const inviterName = invitation.invitedBy?.displayName || invitation.invitedBy?.login || "Workspace管理者";
  const days = remainingDays(invitation.expiresAt);
  const expiring = days <= 2;

  const accept = async () => {
    setBusy("accept");
    try {
      await apiFetch(`/api/me/invitations/${invitation.id}/accept`, { method: "POST" });
      document.cookie = `rulebranch_ws=${encodeURIComponent(invitation.workspaceId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      toast.add(`${workspaceName} に参加しました`);
      window.location.assign(`/w/${encodeURIComponent(invitation.workspaceId)}`);
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy("decline");
    try {
      await apiFetch(`/api/me/invitations/${invitation.id}/decline`, { method: "POST" });
      toast.add(`${workspaceName} への招待を辞退しました`);
      setConfirmDecline(false);
      router.refresh();
    } catch (error) {
      toast.add(getErrorMessage(error instanceof ApiError ? error.code : "INTERNAL_ERROR"));
    } finally {
      setBusy(null);
    }
  };

  return <>
    <article className="personalInvitationCard">
      <div className="personalInvitationTop">
        <span className="personalInvitationIcon"><Building2 size={20}/></span>
        <div className="personalInvitationTitle">
          <span className="personalInvitationKicker">NEW INVITATION</span>
          <h2>{workspaceName}</h2>
          <p><UserRound size={13}/><strong>{inviterName}</strong> から招待されています</p>
        </div>
        <span className={`personalInvitationExpiry${expiring ? " expiring" : ""}`}>
          <Clock3 size={13}/>
          {expiryLabel(invitation.expiresAt)}
        </span>
      </div>

      <div className="personalInvitationDetails">
        <div className="personalInvitationRole">
          <span className="personalInvitationDetailLabel">付与される権限</span>
          <div>
            <span className={`memberRoleBadge ${invitation.role}`}>{roleLabel[invitation.role] ?? invitation.role}</span>
            <span>{roleDescription[invitation.role] ?? "Workspaceで付与される権限です。"}</span>
          </div>
        </div>

        <div className="personalInvitationDeadline">
          <span className="personalInvitationDetailLabel">招待期限</span>
          <strong className={expiring ? "expiring" : ""}>{expiryLabel(invitation.expiresAt)}</strong>
          <small>{new Date(invitation.expiresAt).toLocaleDateString("ja-JP")}まで</small>
        </div>
      </div>

      {invitation.message && <blockquote className="personalInvitationMessage">
        <MessageSquareQuote size={16}/>
        <div>
          <span>Message from {inviterName}</span>
          <p>{invitation.message}</p>
        </div>
      </blockquote>}

      <footer className="personalInvitationActions">
        <button type="button" className="invitationDeclineAction" disabled={busy !== null} onClick={() => setConfirmDecline(true)}>辞退する</button>
        <Button type="button" loading={busy === "accept"} disabled={busy !== null} onClick={() => void accept()}>
          <ShieldCheck size={15}/>Workspaceに参加 <ArrowRight size={15}/>
        </Button>
      </footer>
    </article>

    {confirmDecline && <Dialog open onClose={() => busy === null && setConfirmDecline(false)}>
      <div className="memberConfirmDialog invitationDeclineDialog">
        <span className="memberConfirmIcon"><Clock3 size={20}/></span>
        <h2>招待を辞退しますか？</h2>
        <p><strong>{workspaceName}</strong> への招待を辞退します。</p>
        <p>必要になった場合は、Workspace管理者から再度招待してもらえます。</p>
        <DialogActions
          className="memberDialogActions"
          onCancel={() => setConfirmDecline(false)}
          onConfirm={() => void decline()}
          confirmLabel="辞退する"
          confirmVariant="danger"
          cancelVariant="ghost"
          loading={busy === "decline"}
          confirmDisabled={busy !== null}
          cancelDisabled={busy !== null}
        />
      </div>
    </Dialog>}
  </>;
}
