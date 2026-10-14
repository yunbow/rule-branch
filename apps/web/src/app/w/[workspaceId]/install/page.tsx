import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { ExternalLink } from "lucide-react";
import { Breadcrumbs, PageHeader, PageSection } from "../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../../../shared/permissions.ts";
import { loginPathForContinuation } from "../../../../shared/auth-navigation.ts";

export default async function InstallPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));

  const { workspace, membership } = await getWorkspaceAccess(workspaceId, String(user.id));
  if (!workspace || !membership || !hasWorkspacePermission(
    workspace.kind as WorkspaceKind,
    membership.role as WorkspaceRole,
    "admin",
  )) notFound();

  const slug = process.env.GITHUB_APP_SLUG;

  return <main className="pageContainer pageContainerNarrow">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>GitHub App</span>
    </Breadcrumbs>

    <PageHeader
      eyebrow="GitHub連携"
      title="GitHub Appを接続"
      description="解析対象のリポジトリをRuleBranchへ接続します。インストール後に対象リポジトリを選択できます。"
    />

    <PageSection title="必要な権限" description="RuleBranchがルール解析とDraft PR作成に利用するGitHub App権限です。">
      <div className="detailMetaGrid">
        <div className="detailMetaItem"><span>Repository contents</span><strong>コード・生成物の参照</strong></div>
        <div className="detailMetaItem"><span>Metadata</span><strong>リポジトリ情報の参照</strong></div>
        <div className="detailMetaItem"><span>Pull requests</span><strong>Draft PRの作成・確認</strong></div>
      </div>
      <div className="noticeBanner warning">
        Repository selection は <strong>Selected repositories</strong> を選択してください。All repositories は利用しません。
      </div>
      <div className="formActions">
        {slug
          ? <a className="button primary" href={`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`} target="_blank" rel="noopener noreferrer">
              GitHubでインストール <ExternalLink size={15}/>
            </a>
          : <span className="noticeBanner danger">GitHub Appが設定されていません。</span>}
      </div>
    </PageSection>
  </main>;
}
