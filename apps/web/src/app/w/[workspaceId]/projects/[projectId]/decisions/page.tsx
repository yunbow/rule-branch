import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionMemoryList } from "../../../../../../components/domain/DecisionMemoryList.tsx";
import { ProjectNav } from "../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../shared/runtime.ts";

export default async function DecisionsPage({ params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const { workspaceId, projectId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.projectRepositories) notFound();

  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();
  const project = await runtime.projectRepositories.getProject(workspaceId, uid, projectId);

  return <main className="pageContainer decisionPage">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <span>判断記録</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="判断記録"
      title="判断記録"
      description="過去のルール承認で何を決めたのか、その理由と関連情報を確認できます。"
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    <DecisionMemoryList workspaceId={workspaceId} projectId={projectId}/>
  </main>;
}
