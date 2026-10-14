import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleCreateForm } from "../../../../../../../components/domain/RuleCreateForm.tsx";
import { ProjectNav } from "../../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader, PageSection } from "../../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../../shared/runtime.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../../../shared/permissions.ts";

export default async function NewProjectRulePage({ params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const { workspaceId, projectId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.projectRepositories) notFound();

  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  const [project, repositories] = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, uid, projectId),
    runtime.projectRepositories.listRepositories(workspaceId, uid, projectId),
  ]);

  return <main className="pageContainer pageContainerNarrow">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}/rules`}>ルール</Link>
      <span className="separator">/</span>
      <span>新規作成</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="プロジェクトルール"
      title="プロジェクトルールを作成"
      description="STEP 1/2：基本設定を保存した後、初版本文と根拠を登録します。"
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    <div className="ruleCreateWorkflow"><span className="active">1 基本設定</span><span>2 初版本文・根拠</span></div>
    <PageSection>
      <RuleCreateForm
        workspaceId={workspaceId}
        projectId={projectId}
        writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)}
        repositories={repositories.filter((item) => item.status === "active").map((item) => ({ id: String(item.id), fullName: String(item.fullName) }))}
      />
    </PageSection>
  </main>;
}
