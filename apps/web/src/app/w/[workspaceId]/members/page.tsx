import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { LockKeyhole, UserRound } from "lucide-react";
import type { Member, PendingInvitation } from "../../../../components/domain/MemberTable.tsx";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { MembersClient } from "./MembersClient.tsx";
import { getPendingWorkspaceInvitations, getWorkspaceAccess, getWorkspaceMembers } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { hasRole, type WorkspaceKind, type WorkspaceRole } from "../../../../shared/permissions.ts";
import { loginPathForContinuation } from "../../../../shared/auth-navigation.ts";

export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));

  const { workspaceId } = await params;
  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();

  const kind = workspace.kind as WorkspaceKind;
  const role = membership.role as WorkspaceRole;

  if (kind === "personal") {
    return <main className="pageContainer">
      <Breadcrumbs>
        <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
        <span className="separator">/</span>
        <span>メンバー</span>
      </Breadcrumbs>
      <PageHeader
        eyebrow="メンバー管理"
        title="メンバー"
        description="Workspaceへのアクセスと権限を管理します。"
      />
      <section className="personalWorkspaceNotice">
        <span className="personalWorkspaceIcon"><LockKeyhole size={22}/></span>
        <div>
          <span className="membersSectionKicker">個人Workspace</span>
          <h2>あなた専用のWorkspaceです</h2>
          <p>個人Workspaceはオーナー1名のみで利用します。チームでRuleBranchを利用する場合は組織Workspaceを使用してください。</p>
          <div className="personalOwnerRow">
            <span className="memberAvatar"><UserRound size={18}/></span>
            <div><strong>{String(user.displayName)}</strong><small>オーナー · あなた</small></div>
          </div>
        </div>
      </section>
    </main>;
  }

  const [members, invitations] = await Promise.all([
    getWorkspaceMembers(workspaceId, userId),
    hasRole(role, "admin") ? getPendingWorkspaceInvitations(workspaceId, userId) : Promise.resolve([]),
  ]);

  return <MembersClient
    workspaceId={workspaceId}
    workspaceName={String(workspace.name)}
    actorUserId={userId}
    kind={kind}
    role={role}
    members={members as Member[]}
    invitations={invitations as PendingInvitation[]}
  />;
}
