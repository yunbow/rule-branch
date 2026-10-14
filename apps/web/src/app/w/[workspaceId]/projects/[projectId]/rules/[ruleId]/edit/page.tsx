import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleMetaEditForm } from "../../../../../../../../components/domain/RuleMetaEditForm.tsx";
import { ProjectNav } from "../../../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../../../components/ui/Page.tsx";
import { StatusBadge } from "../../../../../../../../components/ui/index.tsx";
import { getWorkspaceAccess } from "../../../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../../../shared/runtime.ts";
import { isRuleStoreError } from "../../../../../../../../shared/rulestore.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../../../../shared/permissions.ts";

export default async function EditProjectRulePage({ params }: {
  params: Promise<{ workspaceId: string; projectId: string; ruleId: string }>;
}) {
  const { workspaceId, projectId, ruleId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.rules || !runtime.projectRepositories) notFound();
  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  const data = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, uid, projectId),
    runtime.rules.getRule(workspaceId, uid, ruleId),
    runtime.projectRepositories.listRepositories(workspaceId, uid, projectId),
  ]).catch((error: unknown) => {
    if (isRuleStoreError(error) && ["NOT_FOUND", "FORBIDDEN"].includes(error.code)) notFound();
    throw error;
  });
  const [project, rule, repositories] = data;
  if (rule.projectId !== projectId || rule.scopeType !== "project") notFound();
  const base = `/w/${workspaceId}/projects/${projectId}/rules/${ruleId}`;

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <Link href={base}>{String(rule.title)}</Link>
      <span className="separator">/</span>
      <span>ルール設定を編集</span>
    </Breadcrumbs>
    <PageHeader eyebrow="ルール設定を編集" title={String(rule.title)}
      description="基本情報・適用条件・変更監視の設定を更新します。"
      meta={<>
        <span className="ruleMetaHeaderFact"><span>状態</span><StatusBadge kind="rules.status" value={String(rule.status)}/></span>
        <span className="ruleMetaHeaderFact"><span>プロジェクト</span><strong>{String(project.name)}</strong></span>
      </>}/>
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    <RuleMetaEditForm key={`${rule.id}:${rule.updatedAt}`} workspaceId={workspaceId} rule={rule}
        repositories={repositories.map((repository) => ({ id: String(repository.id), fullName: String(repository.fullName), status: String(repository.status) }))}
        writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)} backHref={base}/>
  </main>;
}
