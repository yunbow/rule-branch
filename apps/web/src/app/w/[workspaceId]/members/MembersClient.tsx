"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserPlus, UsersRound, ShieldCheck, MailClock } from "lucide-react";
import { InviteDialog } from "../../../../components/domain/InviteDialog.tsx";
import { MemberTable, type Member, type PendingInvitation } from "../../../../components/domain/MemberTable.tsx";
import { Button } from "../../../../components/ui/index.tsx";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { hasRole, type WorkspaceKind, type WorkspaceRole } from "../../../../shared/permissions.ts";

export function MembersClient({
  workspaceId,
  workspaceName,
  actorUserId,
  kind,
  role,
  members,
  invitations,
}: {
  workspaceId: string;
  workspaceName: string;
  actorUserId: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  members: Member[];
  invitations: PendingInvitation[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const canManage = hasRole(role, "admin");
  const managerCount = members.filter((member) => member.role === "owner" || member.role === "admin").length;

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{workspaceName}</Link>
      <span className="separator">/</span>
      <span>メンバー</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="メンバー管理"
      title="メンバー"
      description="Workspaceへのアクセスと権限を管理します。必要な権限だけを付与し、招待中のユーザーも確認できます。"
      actions={canManage
        ? <Button onClick={() => setOpen(true)}><UserPlus size={15}/>メンバーを招待</Button>
        : undefined}
    />

    <section className="membersSummaryGrid" aria-label="メンバー管理サマリー">
      <div className="membersSummaryCard">
        <span className="membersSummaryIcon"><UsersRound size={18}/></span>
        <span>メンバー</span><strong>{members.length}</strong><small>Workspace参加中</small>
      </div>
      <div className="membersSummaryCard">
        <span className="membersSummaryIcon"><ShieldCheck size={18}/></span>
        <span>管理者</span><strong>{managerCount}</strong><small>オーナー / 管理者</small>
      </div>
      <div className="membersSummaryCard">
        <span className="membersSummaryIcon"><MailClock size={18}/></span>
        <span>招待中</span><strong>{canManage ? invitations.length : "—"}</strong><small>{canManage ? "招待承諾待ち" : "管理者以上のみ表示"}</small>
      </div>
    </section>

    <MemberTable
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      actorUserId={actorUserId}
      workspaceKind={kind}
      actorRole={role}
      members={members}
      invitations={invitations}
    />

    {open && <InviteDialog workspaceId={workspaceId} role={role} onClose={() => setOpen(false)} onInvited={() => router.refresh()}/>}
  </main>;
}
