import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleDetailHeader } from "../../../../../components/domain/RuleDetailHeader.tsx";
import { RuleDetailActions } from "../../../../../components/domain/RuleDetailActions.tsx";
import { LifecycleActionMenu } from "../../../../../components/domain/LifecycleActionMenu.tsx";
import { VersionBody } from "../../../../../components/domain/VersionBody.tsx";
import { VersionHistoryTable } from "../../../../../components/domain/VersionHistoryTable.tsx";
import { EmptyState } from "../../../../../components/ui/index.tsx";
import { Breadcrumbs, PageSection } from "../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../server/session.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../shared/permissions.ts";

export default async function OrganizationRuleDetailPage({ params, searchParams }: {
  params: Promise<{ workspaceId: string; ruleId: string }>;
  searchParams: Promise<{ approved?: string }>;
}) {
  const { workspaceId, ruleId } = await params;
  const query = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.rules) notFound();
  const uid = String(user.id);
  const [{ workspace, membership }, rule, versions, allRules] = await Promise.all([
    getWorkspaceAccess(workspaceId, uid),
    runtime.rules.getRule(workspaceId, uid, ruleId),
    runtime.rules.listRuleVersions(workspaceId, uid, ruleId) as Promise<Record<string, unknown>[]>,
    runtime.rules.listRules(workspaceId, uid),
  ]);
  if (!workspace || !membership || rule.scopeType !== "organization" || rule.scopeId !== workspaceId) notFound();
  const base = `/w/${workspaceId}/rules/${ruleId}`;
  const current = versions.find((version) => version.id === rule.currentVersionId);
  const kind = workspace.kind as WorkspaceKind;
  const role = membership.role as WorkspaceRole;
  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/rules`}>組織ルール</Link>
      <span className="separator">/</span><span>{String(rule.title)}</span>
    </Breadcrumbs>
    <RuleDetailHeader rule={rule} workspaceId={workspaceId} actions={<RuleDetailActions
      workspaceId={workspaceId} rule={rule} repositories={[]} writable={canWrite(kind, role)}/>}/>
    {query.approved === "1" && <div className="noticeBanner success" role="status">承認しました。対象リポジトリへの公開準備を開始しています。</div>}
    <LifecycleActionMenu rule={rule} allRules={allRules.filter((item) => item.scopeType === "organization")}
      versions={versions} workspaceId={workspaceId} basePath={base} kind={kind} role={role}/>
    <PageSection title="適用範囲" description="このルールは組織Workspace全体に適用されます。">
      <div className="detailMetaGrid">
        <div className="detailMetaItem"><span>Scope</span><strong>組織全体</strong></div>
        <div className="detailMetaItem"><span>ルールキー</span><strong>{String(rule.key)}</strong></div>
        <div className="detailMetaItem"><span>評価方法</span><strong>{String(rule.evaluationMode ?? "—")}</strong></div>
      </div>
    </PageSection>
    <PageSection title="現行Version" description="現在正式に採用されているルール本文です。">
      {current ? <div className="sectionStack">
        <Link className="button secondary" href={`${base}/versions/${current.id}`}>Version詳細</Link>
        <div className="contentPanel"><VersionBody content={String(current.content)} provenance={current.provenance as Record<string, unknown>}/></div>
      </div> : <EmptyState>現行Versionはありません。</EmptyState>}
    </PageSection>
    <PageSection title="Version履歴" description="提案・承認・却下を含む変更履歴です。">
      <VersionHistoryTable versions={versions} basePath={base}/>
    </PageSection>
  </main>;
}
