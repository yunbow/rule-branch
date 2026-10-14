import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { ArrowLeft, CheckCircle2, Inbox } from "lucide-react";
import { InvitationCard, type Invitation } from "../../components/domain/InvitationCard.tsx";
import { PageHeader } from "../../components/ui/Page.tsx";
import { getMyInvitations } from "../../server/queries.ts";
import { getSessionUser } from "../../server/session.ts";
import { loginPathForContinuation } from "../../shared/auth-navigation.ts";

export default async function InvitationsPage() {
  const user = await getSessionUser();
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));

  const invitations = await getMyInvitations(String(user.id));

  return <div className="accountPage">
    <header className="accountHeader">
      <Link className="accountBrand" href="/">
        <span className="appBrandMark">RB</span>
        <strong>RuleBranch</strong>
      </Link>
      <Link className="accountBackLink" href="/"><ArrowLeft size={14}/>Workspaceへ戻る</Link>
      <span className="accountUserName">{String(user.displayName)}</span>
    </header>

    <main className="pageContainer pageContainerNarrow">
      <PageHeader
        eyebrow="ワークスペース招待"
        title="Workspaceへの招待"
        description="参加するWorkspace、付与される権限、招待期限を確認してから参加してください。"
        actions={<div className="invitationCount" aria-label={`未処理の招待 ${invitations.length}件`}>
          <Inbox size={17}/>
          <strong>{invitations.length}</strong>
          <span>未処理の招待</span>
        </div>}
      />

      {invitations.length === 0 ? <section className="invitationEmptyState">
        <span><CheckCircle2 size={24}/></span>
        <div>
          <h2>未処理の招待はありません</h2>
          <p>新しいWorkspaceへの招待が届くと、この画面に表示されます。</p>
          <Link href="/">Workspaceへ戻る →</Link>
        </div>
      </section> : <section className="invitationInboxList" aria-label="Workspace招待一覧">
        {invitations.map((invitation) => <InvitationCard key={String(invitation.id)} invitation={invitation as Invitation}/>)}
      </section>}
    </main>
  </div>;
}
