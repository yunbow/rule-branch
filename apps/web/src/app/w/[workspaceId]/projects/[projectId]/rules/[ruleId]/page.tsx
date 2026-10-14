import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleDetailHeader } from "../../../../../../../components/domain/RuleDetailHeader.tsx";
import { VersionHistoryTable } from "../../../../../../../components/domain/VersionHistoryTable.tsx";
import { VersionBody } from "../../../../../../../components/domain/VersionBody.tsx";
import { LifecycleActionMenu } from "../../../../../../../components/domain/LifecycleActionMenu.tsx";
import { EmptyState } from "../../../../../../../components/ui/index.tsx";
import { RuleDetailActions } from "../../../../../../../components/domain/RuleDetailActions.tsx";
import { PublicationBadge } from "../../../../../../../components/domain/PublicationBadge.tsx";
import { ProjectNav } from "../../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageSection } from "../../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../../shared/runtime.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../../../shared/permissions.ts";

export default async function RuleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string; ruleId: string }>;
  searchParams: Promise<{ approved?: string }>;
}) {
  const { workspaceId, projectId, ruleId } = await params;
  const query = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.rules || !runtime.drift || !runtime.projectRepositories) notFound();

  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  const [project, rule, rawVersions, allRules, findings, memories, repositories] = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, uid, projectId),
    runtime.rules.getRule(workspaceId, uid, ruleId),
    runtime.rules.listRuleVersions(workspaceId, uid, ruleId),
    runtime.rules.listProjectRules(workspaceId, uid, projectId),
    runtime.drift.listForRule(workspaceId, uid, ruleId),
    runtime.rules.listDecisionMemoriesForRule(workspaceId, uid, projectId, ruleId),
    runtime.projectRepositories.listRepositories(workspaceId, uid, projectId),
  ]);
  if (rule.projectId !== projectId) notFound();

  const repositoryViews = repositories.map((item) => ({
    id: String(item.id),
    fullName: String(item.fullName),
    status: String(item.status),
  }));
  const versions = rawVersions as Record<string, unknown>[];
  const current = typeof rule.currentVersionId === "string"
    ? versions.find((item) => item.id === rule.currentVersionId)
    : undefined;
  const base = `/w/${workspaceId}/projects/${projectId}/rules/${ruleId}`;

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}/rules`}>ルール</Link>
      <span className="separator">/</span>
      <span>{String(rule.title)}</span>
    </Breadcrumbs>

    <RuleDetailHeader
      rule={rule}
      workspaceId={workspaceId}
      repositories={repositoryViews}
      actions={<RuleDetailActions
        workspaceId={workspaceId}
        rule={rule}
        repositories={repositoryViews}
        writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)}
      />}
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>

    {query.approved === "1" && <div className="noticeBanner success">
      <div><strong>承認しました。</strong> GitHubへの公開準備を開始しています。</div>
      <Link href={`/w/${workspaceId}/projects/${projectId}/publications`}>Draft PRの状態を見る</Link>
    </div>}

    <LifecycleActionMenu
      rule={rule}
      allRules={allRules}
      versions={versions}
      workspaceId={workspaceId}
      basePath={base}
      kind={workspace.kind as WorkspaceKind}
      role={membership.role as WorkspaceRole}
    />

    <PageSection title="現行Version" description="現在正式に採用されているルール本文です。">
      {current ? <div className="sectionStack">
        <div className="inlineActions">
          <PublicationBadge versionId={String(current.id)} workspaceId={workspaceId} repositories={repositoryViews}/>
          <Link className="button secondary" href={`${base}/versions/${current.id}`}>Version詳細</Link>
        </div>
        <div className="contentPanel">
          <VersionBody content={String(current.content)} provenance={current.provenance as Record<string, unknown>}/>
        </div>
      </div> : <EmptyState>現行Versionはありません。</EmptyState>}
    </PageSection>

    <PageSection title="Version履歴" description="提案・承認・却下を含む変更履歴です。">
      <VersionHistoryTable versions={versions} basePath={base}/>
    </PageSection>

    <PageSection title="関連するDrift" description="このルールに対して検出された変化です。">
      {findings.length ? <div className="detailList">
        {findings.map((item) => <details key={String(item.id)}>
          <summary>{String(item.title ?? item.id)} · {String(item.status)}</summary>
          <p>{String(item.detail ?? item.description ?? "")}</p>
        </details>)}
      </div> : <EmptyState>関連するDriftはありません。</EmptyState>}
    </PageSection>

    <PageSection title="関連する判断記録" description="このルールの採用・変更時に残された判断です。">
      {memories.length ? <div className="cardList">
        {memories.map((item) => <article className="contentPanel" key={String(item.id)}>
          <h3>{String(item.title)}</h3>
          <p>{String(item.decision ?? item.context ?? "")}</p>
        </article>)}
      </div> : <EmptyState>関連する判断記録はありません。</EmptyState>}
    </PageSection>
  </main>;
}
