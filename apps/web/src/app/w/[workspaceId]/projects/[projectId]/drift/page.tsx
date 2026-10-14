import Link from "next/link";
import { notFound } from "next/navigation";
import { DriftListClient, type DriftRule } from "../../../../../../components/domain/DriftListClient.tsx";
import type { FindingView } from "../../../../../../components/domain/FindingRow.tsx";
import type { JobView } from "../../../../../../components/domain/JobProgress.tsx";
import type { DriftSort } from "../../../../../../lib/drift-presentation.ts";
import { ProjectNav } from "../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess, getProjectJobs } from "../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../shared/runtime.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../../../../../shared/permissions.ts";

export default async function DriftPage({
  params, searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{
    tab?: string; type?: string; path?: string; status?: string;
    q?: string; severity?: string; repo?: string; sort?: string;
  }>;
}) {
  const { workspaceId, projectId } = await params;
  const query = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.drift || !runtime.rules || !runtime.projectRepositories) notFound();

  const userId = String(user.id);
  const [{ workspace, membership }, project] = await Promise.all([
    getWorkspaceAccess(workspaceId, userId),
    runtime.projectRepositories.getProject(workspaceId, userId, projectId),
  ]);
  if (!workspace || !membership || !project) notFound();

  const [allFindings, rawRules, rawRepositories, rawTriggers, projectJobs] = await Promise.all([
    runtime.drift.list(workspaceId, userId),
    runtime.rules.listProjectRules(workspaceId, userId, projectId),
    runtime.projectRepositories.listRepositories(workspaceId, userId, projectId),
    runtime.store.list({ workspaceId, actorUserId: userId }, "change_triggers", { projectId }),
    getProjectJobs(workspaceId, userId, projectId),
  ]);
  const rules = (rawRules as Record<string, unknown>[]).map((rule) => ({
    id: String(rule.id),
    title: String(rule.title),
    projectId: typeof rule.projectId === "string" ? rule.projectId : null,
    status: String(rule.status),
    staleSince: typeof rule.staleSince === "string" ? rule.staleSince : null,
  })) satisfies DriftRule[];
  const ruleIds = new Set(rules.map((rule) => rule.id));
  // AI-generated findings reference their repository through the scan trigger
  // rather than carrying repositoryId directly. Resolve it for accurate filters.
  const repositoryByTrigger = new Map((rawTriggers as Record<string, unknown>[]).map((trigger) => {
    const source = trigger.source && typeof trigger.source === "object"
      ? trigger.source as Record<string, unknown> : {};
    return [String(trigger.id), typeof source.repositoryId === "string" ? source.repositoryId : null] as const;
  }));
  const findings = (allFindings as Record<string, unknown>[])
    .filter((finding) => finding.scopeId === projectId || finding.projectId === projectId || (
      typeof finding.ruleId === "string" && ruleIds.has(finding.ruleId)
    ))
    .map((finding) => ({
      ...finding,
      id: String(finding.id),
      ruleId: typeof finding.ruleId === "string" ? finding.ruleId : null,
      repositoryId: typeof finding.repositoryId === "string" ? finding.repositoryId
        : typeof finding.triggerId === "string" ? repositoryByTrigger.get(finding.triggerId) ?? null : null,
      status: String(finding.status),
      driftType: String(finding.driftType),
      severity: String(finding.severity),
      confidence: Number(finding.confidence ?? 0),
      summary: typeof finding.summary === "string" ? finding.summary : undefined,
      detail: typeof finding.detail === "string" ? finding.detail : undefined,
      createdAt: typeof finding.createdAt === "string" ? finding.createdAt : undefined,
      proposalVersionId: typeof finding.proposalVersionId === "string" ? finding.proposalVersionId : null,
      proposalVersionStatus: typeof finding.proposalVersionStatus === "string" ? finding.proposalVersionStatus : null,
      evidenceIds: Array.isArray(finding.evidenceIds)
        ? finding.evidenceIds.filter((id): id is string => typeof id === "string")
        : [],
      provenance: typeof finding.provenance === "object" && finding.provenance
        ? finding.provenance as { sourceType?: string }
        : undefined,
    })) as FindingView[];

  const activeRepositories = rawRepositories.filter((repository) => repository.status === "active");
  const selectedSort: DriftSort = query.sort === "recent" || query.sort === "confidence"
    ? query.sort : "priority";
  const selectedSeverity = ["high", "medium", "low", "info"].includes(query.severity ?? "")
    ? query.severity : "";
  const selectedRepository = activeRepositories.some((repository) => repository.id === query.repo)
    ? query.repo : "";

  return <main className="pageContainer driftPage">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <span>ずれの検知</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="Drift監視"
      title="ルールとコードのずれ"
      description="検出されたずれを確認し、対応するルールと指摘を判断します。"
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    <details className="driftScopeNote">
      <summary>
        <span>検知対象：<code>package.json</code>の依存関係変更など</span>
        <span>対象範囲と制限を見る</span>
      </summary>
      <div className="driftScopeBody">
        <p>依存Driftの解析は、各リポジトリのpackage.jsonにあるdependencies・devDependencies・peerDependenciesが対象です。モノレポ内のpackage.jsonも対象に含みます。</p>
        <p>自動スキャンはデフォルトブランチの依存ファイル更新が起点です。手動スキャンは現在のコミットを読み、承認済みルールの本文と比較します。Python・Javaなどの依存定義や、コードの実装慣行・PRレビューの継続解析は現在の対象外です。</p>
        <p>すべてのコード変更を検査するものではありません。指摘の根拠を確認して対応対象を選び、改定提案を生成・承認した後、Draft PRをマージして反映を検証してください。</p>
      </div>
    </details>
    <DriftListClient
      workspaceId={workspaceId}
      projectId={projectId}
      workspaceKind={workspace.kind as WorkspaceKind}
      role={membership.role as WorkspaceRole}
      rules={rules}
      findings={findings}
      initialType={query.type === "artifact_mismatch" ? query.type : ""}
      initialPath={query.type === "artifact_mismatch" && typeof query.path === "string" ? query.path.slice(0, 1024) : ""}
      initialTab={query.tab === "findings" || query.type === "artifact_mismatch" ? "findings" : "stale"}
      initialStatus={typeof query.status === "string" ? query.status : undefined}
      initialSearch={typeof query.q === "string" ? query.q.slice(0, 100) : ""}
      initialSeverity={selectedSeverity}
      initialRepositoryId={selectedRepository}
      initialSort={selectedSort}
      initialJobs={projectJobs.filter((item) => item.type === "drift_scan" &&
        ["queued", "running"].includes(String(item.status))) as JobView[]}
      repositories={activeRepositories.map((repository) => ({
        id: String(repository.id),
        fullName: String(repository.fullName),
      }))}
    />
  </main>;
}

