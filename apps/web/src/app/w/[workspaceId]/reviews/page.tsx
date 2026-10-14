import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, Bot, CheckCircle2, ChevronRight, CircleHelp, Clock3 } from "lucide-react";
import { getProjects, getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
import { ApprovalReviewSummary, getApprovalReasonLabel } from "../../../../components/domain/ApprovalReviewSummary.tsx";
import { ReviewRefreshButton } from "../../../../components/domain/ReviewRefreshButton.tsx";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { getReviewState, type ReviewState } from "../../../../lib/workspace-overview.ts";

type SortMode = "priority" | "oldest" | "newest";

function getReasonCodes(version: Record<string, unknown>) {
  const review = version.approvalReview as Record<string, unknown> | undefined;
  return Array.isArray(review?.reasonCodes) ? review.reasonCodes.map(String) : [];
}

function formatAge(value: unknown) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分待ち`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間待ち`;
  return `${Math.floor(hours / 24)}日待ち`;
}

function stateMeta(state: ReviewState) {
  if (state === "human_required") return { label: "人間確認", className: "human", icon: <AlertCircle size={15}/> };
  if (state === "evaluating") return { label: "AI評価中", className: "evaluating", icon: <Bot size={15}/> };
  return { label: "未評価", className: "unreviewed", icon: <CircleHelp size={15}/> };
}

export default async function ApprovalReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ status?: string; project?: string; reason?: string; sort?: string; q?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.rules || !runtime.store) notFound();

  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();

  const [versions, projects] = await Promise.all([
    runtime.rules.listReviewQueue(workspaceId, userId),
    getProjects(workspaceId, userId),
  ]);
  const rules = await runtime.store.getMany(
    { workspaceId, actorUserId: userId },
    "rules",
    versions.map((version) => String(version.ruleId)),
  );

  const byId = new Map(rules.map((rule) => [String(rule.id), rule]));
  const projectById = new Map(projects.map((project) => [String(project.id), project]));
  const proposals = (versions as Record<string, unknown>[]).filter((version) => byId.has(String(version.ruleId)));

  const statusFilter = (["human_required", "evaluating", "unreviewed"] as const).includes(query.status as ReviewState)
    ? query.status as ReviewState
    : "all";
  const projectFilter = typeof query.project === "string" ? query.project : "";
  const reasonFilter = typeof query.reason === "string" ? query.reason : "";
  const searchQuery = typeof query.q === "string" ? query.q.slice(0,160).trim() : "";
  const sortMode: SortMode = (["priority", "oldest", "newest"] as const).includes(query.sort as SortMode)
    ? query.sort as SortMode
    : "priority";

  const projectProposals = proposals.filter((version) =>
    !projectFilter || String(byId.get(String(version.ruleId))?.projectId ?? "") === projectFilter);
  const counts = {
    human_required: projectProposals.filter((version) => getReviewState(version) === "human_required").length,
    evaluating: projectProposals.filter((version) => getReviewState(version) === "evaluating").length,
    unreviewed: projectProposals.filter((version) => getReviewState(version) === "unreviewed").length,
  };

  const reasonOptions = [...new Set(projectProposals.flatMap(getReasonCodes))].sort((a, b) =>
    getApprovalReasonLabel(a).localeCompare(getApprovalReasonLabel(b), "ja"),
  );

  const filtered = proposals.filter((version) => {
    const rule = byId.get(String(version.ruleId))!;
    if (statusFilter !== "all" && getReviewState(version) !== statusFilter) return false;
    if (projectFilter && String(rule.projectId ?? "") !== projectFilter) return false;
    if (reasonFilter && !getReasonCodes(version).includes(reasonFilter)) return false;
    if (searchQuery && !(`${String(rule.title ?? "")} ${String(rule.key ?? "")}`
      .toLocaleLowerCase("ja").includes(searchQuery.toLocaleLowerCase("ja")))) return false;
    return true;
  });

  const priority = (version: Record<string, unknown>) => {
    const state = getReviewState(version);
    return state === "human_required" ? 0 : state === "unreviewed" ? 1 : 2;
  };
  filtered.sort((a, b) => {
    const aTime = String(a.createdAt ?? "");
    const bTime = String(b.createdAt ?? "");
    if (sortMode === "oldest") return aTime.localeCompare(bTime);
    if (sortMode === "newest") return bTime.localeCompare(aTime);
    return priority(a) - priority(b) || aTime.localeCompare(bTime);
  });

  const buildHref = (status: "all" | ReviewState) => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (projectFilter) params.set("project", projectFilter);
    if (reasonFilter) params.set("reason", reasonFilter);
    if (searchQuery) params.set("q", searchQuery);
    if (sortMode !== "priority") params.set("sort", sortMode);
    const suffix = params.toString();
    return `/w/${workspaceId}/reviews${suffix ? `?${suffix}` : ""}`;
  };

  const hasFilters = statusFilter !== "all" || Boolean(projectFilter) || Boolean(reasonFilter) || Boolean(searchQuery) || sortMode !== "priority";

  return <main className="pageContainer reviewInboxUnified">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>承認待ち</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="人間へのエスカレーション"
      title="承認待ち"
      description="人間確認・AI評価中・未評価の提案を、状態別に確認できます。判断時は差分と根拠を確認してください。"
      actions={<ReviewRefreshButton/>}
    />

    {projectFilter && <p className="reviewProjectScopeNote">件数は選択したプロジェクト内の集計です。</p>}

    <nav className="reviewStateTabs" aria-label="承認状態で絞り込み">
      <Link className={statusFilter === "all" ? "active" : ""} href={buildHref("all")}>すべて <span>{projectProposals.length}</span></Link>
      <Link className={statusFilter === "human_required" ? "active" : ""} href={buildHref("human_required")}>人間確認 <span>{counts.human_required}</span></Link>
      <Link className={statusFilter === "evaluating" ? "active" : ""} href={buildHref("evaluating")}>AI評価中 <span>{counts.evaluating}</span></Link>
      <Link className={statusFilter === "unreviewed" ? "active" : ""} href={buildHref("unreviewed")}>未評価 <span>{counts.unreviewed}</span></Link>
    </nav>

    <section className="reviewToolbar">
      <form className="reviewFilters" method="get">
        {statusFilter !== "all" && <input type="hidden" name="status" value={statusFilter}/>}
        <label>検索
          <input type="search" name="q" defaultValue={searchQuery} placeholder="タイトル・キー"/>
        </label>
        <label>プロジェクト
          <select name="project" defaultValue={projectFilter}>
            <option value="">すべて</option>
            {projects.map((project) => <option key={String(project.id)} value={String(project.id)}>{String(project.name)}</option>)}
          </select>
        </label>
        <label>確認理由
          <select name="reason" defaultValue={reasonFilter}>
            <option value="">すべて</option>
            {reasonOptions.map((code) => <option key={code} value={code}>{getApprovalReasonLabel(code)}</option>)}
          </select>
        </label>
        <label>並び順
          <select name="sort" defaultValue={sortMode}>
            <option value="priority">要対応優先</option>
            <option value="oldest">古い順</option>
            <option value="newest">新しい順</option>
          </select>
        </label>
        <button type="submit">絞り込む</button>
        {hasFilters && <Link href={`/w/${workspaceId}/reviews`}>リセット</Link>}
      </form>
      <details className="reviewScoreHelp">
        <summary>AI評価スコアについて</summary>
        <p>Judge scoreやGroundednessは評価指標であり、「正しい確率」を表す値ではありません。差分とEvidenceを確認して判断してください。</p>
      </details>
    </section>

    <div className="reviewResultsHeader">
      <strong>{filtered.length}件</strong>
      <span>{statusFilter === "human_required" ? "人間の判断が必要な提案" : "レビューキュー"}</span>
    </div>

    {filtered.length === 0 ? <section className="reviewEmptyState">
      <CheckCircle2 size={28}/>
      <div>
        <h2>{proposals.length === 0 ? "レビューキューは空です" : "条件に一致する提案はありません"}</h2>
        <p>{proposals.length === 0 ? "AI評価中・未評価を含め、現在レビューキューは空です。" : "フィルタ条件を変更して再度確認してください。"}</p>
        {proposals.length === 0
          ? <Link href={`/w/${workspaceId}`}>Workspace概要へ戻る →</Link>
          : <Link href={`/w/${workspaceId}/reviews`}>フィルタを解除 →</Link>}
      </div>
    </section> : <section className="reviewQueue" aria-label="承認待ち一覧">
      {filtered.map((version) => {
        const rule = byId.get(String(version.ruleId))!;
        const state = getReviewState(version);
        const meta = stateMeta(state);
        const project = typeof rule.projectId === "string" ? projectById.get(rule.projectId) : undefined;
        const href = rule.projectId
          ? `/w/${workspaceId}/projects/${rule.projectId}/rules/${rule.id}/versions/${version.id}`
          : `/w/${workspaceId}/rules/${rule.id}/versions/${version.id}`;
        const age = formatAge(version.createdAt);
        const changeType = typeof version.changeType === "string" ? version.changeType : null;
        const review = version.approvalReview as Record<string, unknown> | undefined;
        const checkedAt = typeof review?.checkedAt === "string" ? review.checkedAt : null;

        return <article className={`reviewQueueCard ${meta.className}`} key={String(version.id)}>
          <div className="reviewCardHeader">
            <div className="reviewCardStatusLine">
              <span className={`reviewStateBadge ${meta.className}`}>{meta.icon}{meta.label}</span>
              {age && <span className="reviewAge"><Clock3 size={13}/>{age}</span>}
            </div>
            <div className="reviewCardTitleRow">
              <div>
                <h2><Link href={href}>{String(rule.title)}</Link></h2>
                <p className="reviewProjectName">{project ? String(project.name) : "Workspaceルール"} <span>·</span> v{String(version.version)}</p>
              </div>
              {changeType && <div className={`reviewChangeType ${changeType}`}><span>変更</span><strong>{changeType}</strong></div>}
            </div>
            {getReasonCodes(version).length > 0 && <p className="reviewPrimaryReason">確認理由：{getApprovalReasonLabel(getReasonCodes(version)[0])}</p>}
            <div className="reviewMeta">
              <span>{String(rule.layer)}</span>
              {rule.type != null && <span>{String(rule.type)}</span>}
              <span>{String(rule.enforcement)}</span>
              {checkedAt && <span>評価: {checkedAt}</span>}
            </div>
          </div>

          <details className="reviewCardDetails">
            <summary>AI評価・確認理由の詳細</summary>
            <ApprovalReviewSummary version={version} workspaceId={workspaceId}/>
          </details>

          <footer className="reviewCardFooter">
            <span>{state === "human_required" ? "差分・Evidence・AI評価を確認して判断してください。" : state === "evaluating" ? "評価完了後に状態が更新されます。" : "手動承認対象、または自動評価開始前です。"}</span>
            <Link className="reviewPrimaryAction" href={href}>
              {state === "human_required" ? "差分と根拠を確認" : "詳細を見る"} <ChevronRight size={16}/>
            </Link>
          </footer>
        </article>;
      })}
    </section>}
  </main>;
}
