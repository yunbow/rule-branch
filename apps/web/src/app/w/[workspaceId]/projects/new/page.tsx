import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ProjectCreateForm } from "../../../../../components/domain/ProjectCreateForm.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../server/session.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../../../../shared/permissions.ts";

export default async function NewProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ installation?: string }>;
}) {
  const { workspaceId } = await params;
  const { installation } = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store) notFound();

  const { workspace, membership } = await getWorkspaceAccess(workspaceId, String(user.id));
  if (!workspace || !membership || !hasWorkspacePermission(
    workspace.kind as WorkspaceKind,
    membership.role as WorkspaceRole,
    "admin",
  )) notFound();

  const installations = await runtime.store.list(
    { workspaceId, actorUserId: String(user.id) },
    "installations",
    { status: "active" },
  );
  const options = installations.map((item) => ({
    id: String(item.id),
    githubInstallationId: String(item.githubInstallationId),
    accountLogin: typeof item.accountLogin === "string" ? item.accountLogin : undefined,
    repositorySelection: String(item.repositorySelection),
  }));
  const selectable = options.filter((item) => item.repositorySelection === "selected");
  const initialInstallationId = selectable.find((item) => item.githubInstallationId === installation)?.id;
  const listHref = `/w/${workspaceId}/projects`;

  return <main className="pageContainer pageContainerNarrow projectCreatePage">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={listHref}>プロジェクト一覧</Link>
      <span className="separator">/</span>
      <span>新規作成</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="プロジェクト管理"
      title="プロジェクトを作成"
      description="名前と解析対象のリポジトリを指定すると、ルール候補の初回解析を開始できます。"
      actions={<Link className="button secondary" href={listHref}><ArrowLeft size={15} aria-hidden="true"/>一覧に戻る</Link>}
    />
    {selectable.length
      ? <ProjectCreateForm workspaceId={workspaceId} installations={selectable} initialInstallationId={initialInstallationId}/>
      : <section className="projectCreateUnavailable">
          <h2>GitHub Appの接続が必要です</h2>
          <p>RuleBranchで利用するリポジトリをGitHub Appから選択してください。接続後、プロジェクトを作成できます。</p>
          <Link className="button primary" href={`/w/${workspaceId}/install`}>GitHub Appの設定へ</Link>
        </section>}
  </main>;
}
