import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicationDashboard } from "../../../../../../components/domain/PublicationDashboard.tsx";
import { ProjectNav } from "../../../../../../components/layout/ProjectNav.tsx";
import { EmptyState } from "../../../../../../components/ui/index.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../components/ui/Page.tsx";
import { normalizePublicationData } from "../../../../../../lib/publication-overview.ts";
import { getWorkspaceAccess } from "../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../shared/runtime.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../../../../../shared/permissions.ts";

export default async function PublicationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.projectRepositories) notFound();

  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  // Fetch once per project instead of issuing two requests from every
  // repository card. The data is filtered to active project repositories.
  const [project, repositories, revisionPrs, compiledArtifacts] = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, uid, projectId),
    runtime.projectRepositories.listRepositories(workspaceId, uid, projectId),
    runtime.projectRepositories.listRevisionPrs(workspaceId, uid),
    runtime.projectRepositories.listCompiledArtifacts(workspaceId, uid),
  ]);
  const activeRepositories = repositories
    .filter((repository) => repository.status === "active" && !repository.deletedAt)
    .map((repository) => ({
      id: String(repository.id),
      fullName: String(repository.fullName),
      defaultBranch: typeof repository.defaultBranch === "string"
        ? repository.defaultBranch : undefined,
    }));
  const activeRepositoryIds = new Set(activeRepositories.map((repository) => repository.id));
  const initialData = normalizePublicationData(revisionPrs, compiledArtifacts, activeRepositoryIds);

  return <main className="pageContainer publicationPage">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <span>反映状況</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="GitHubへの反映"
      title="反映状況"
      description="承認済みルールのDraft PR・マージ・生成物の検証を確認します。"
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    {activeRepositories.length
      ? <PublicationDashboard
          repositories={activeRepositories}
          initialData={initialData}
          initialFetchedAt={new Date().toISOString()}
          workspaceId={workspaceId}
          projectId={projectId}
          kind={workspace.kind as WorkspaceKind}
          role={membership.role as WorkspaceRole}
        />
      : <EmptyState>有効なリポジトリがありません。
          <Link href={`/w/${workspaceId}/projects/${projectId}#repositories`}>プロジェクト概要で連携を確認</Link>
        </EmptyState>}
  </main>;
}
