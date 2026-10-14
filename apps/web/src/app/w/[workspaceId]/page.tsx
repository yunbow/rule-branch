import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, ExternalLink, Inbox, ShieldCheck } from "lucide-react";
import { ProjectGrid } from "../../../components/domain/ProjectGrid.tsx";
import { Card } from "../../../components/ui/index.tsx";
import { PageHeader, PageSection } from "../../../components/ui/Page.tsx";
import {
  getBootstrapStatus,
  summarizeWorkspace,
  type OverviewRecord,
  type BootstrapStatus,
  type WorkspaceProjectSummary,
} from "../../../lib/workspace-overview.ts";
import { getProjects, getRules, getWorkspaceAccess } from "../../../server/queries.ts";
import { getSessionUser } from "../../../server/session.ts";
import { listProjectJobs } from "../../../shared/analysis-jobs.ts";
import { getRuntime } from "../../../shared/runtime.ts";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../../shared/permissions.ts";

type ActionItem = {
  key: string;
  title: string;
  description: string;
  label: string;
  href: string;
  tone: "warning" | "neutral";
};

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  const store = runtime.store;
  if (!user || !store) notFound();

  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();

  const canManage = hasWorkspacePermission(
    workspace.kind as WorkspaceKind,
    membership.role as WorkspaceRole,
    "admin",
  );
  const ctx = { workspaceId, actorUserId: userId };
  const root = `/w/${workspaceId}`;

  const [rawProjects, installations, rawRepositories, rawRules, reviewQueue, driftFindings] = await Promise.all([
    getProjects(workspaceId, userId),
    store.list(ctx, "installations", { status: "active" }),
    store.list(ctx, "repositories", { status: "active" }),
    getRules(workspaceId, userId),
    runtime.rules ? runtime.rules.listReviewQueue(workspaceId, userId) : Promise.resolve([]),
    runtime.drift ? runtime.drift.list(workspaceId, userId) : Promise.resolve([]),
  ]);
  const projects = rawProjects as OverviewRecord[];
  const repositories = rawRepositories as OverviewRecord[];
  const rules = rawRules as OverviewRecord[];
  const reviews = reviewQueue as OverviewRecord[];
  const findings = driftFindings as OverviewRecord[];

  const projectIds = new Set(projects.map((project) => String(project.id)));
  const activeProjectIds = [...new Set(repositories.map((repository) => String(repository.projectId ?? "")))]
    .filter((id) => projectIds.has(id));
  // Publication calculations follow the same selector-aware logic as the Project detail page.
  const versionIds = [...new Set(rules
    .filter((rule) => projectIds.has(String(rule.projectId ?? "")) &&
      !rule.deletedAt && ["active", "stale"].includes(String(rule.status)) &&
      typeof rule.currentVersionId === "string")
    .map((rule) => rule.currentVersionId as string))];

  const [publicationStates, bootstrapEntries] = await Promise.all([
    runtime.rules && versionIds.length
      ? runtime.rules.getPublicationStates(workspaceId, userId, versionIds)
      : Promise.resolve({} as Record<string, OverviewRecord>),
    Promise.all(activeProjectIds.map(async (projectId) => {
      const jobs = await listProjectJobs(store, ctx, projectId, { type: "bootstrap", limit: 1 });
      return [projectId, getBootstrapStatus(jobs[0] as OverviewRecord | undefined)] as const;
    })),
  ]);
  const bootstrapStatusByProject: Record<string, BootstrapStatus> = Object.fromEntries(bootstrapEntries);

  const overview = summarizeWorkspace({
    projects, repositories, rules, reviews, findings,
    publicationStates: runtime.rules ? publicationStates : undefined,
  });

  // Do not mistake a never-scanned Workspace for a healthy, all-clear Workspace.
  const initialized = overview.projects.some((project) =>
    project.repositoryCount > 0 &&
    (bootstrapStatusByProject[project.id] === "done" ||
      project.activeRuleCount > 0 || project.candidateCount > 0),
  );
  const firstWithRepo = overview.projects.find((project) => project.repositoryCount > 0);
  const failedProject = overview.projects.find((project) =>
    project.repositoryCount > 0 && bootstrapStatusByProject[project.id] === "failed");
  const runningProject = overview.projects.find((project) =>
    project.repositoryCount > 0 && bootstrapStatusByProject[project.id] === "running");

  const setupPhase = !installations.length ? "install" :
    !projects.length ? "project" :
    !repositories.length ? "repository" :
    !initialized ? "analysis" : null;
  const focusProject = failedProject ?? runningProject ?? firstWithRepo;
  const setupDetails = setupPhase === "install"
    ? { title: "GitHub Appを接続する", detail: "アクセスを許可するリポジトリはGitHub側で選択できます。", href: `${root}/install`, button: "GitHub Appを接続" }
    : setupPhase === "project"
      ? { title: "プロジェクトを作成する", detail: "ルールを管理する単位を作成してください。", href: `${root}/projects/new`, button: "プロジェクトを作成" }
      : setupPhase === "repository"
        ? { title: "解析するリポジトリを追加する", detail: "プロジェクトを開いて、対象のリポジトリを選択してください。", href: `${root}/projects/${String(projects[0]?.id)}`, button: "リポジトリを追加" }
        : setupPhase === "analysis" && focusProject
          ? {
              title: failedProject ? "初回解析の失敗を確認する" : runningProject ? "初回解析の実行状況を確認する" : "初回解析の状況を確認する",
              detail: failedProject ? "直近の解析が失敗しました。ジョブの詳細から原因を確認してください。"
                : runningProject ? "初回解析を実行中です。完了後にルール候補を確認できます。"
                  : "初回解析の完了記録がありません。プロジェクトで解析ジョブを確認してください。",
              href: `${root}/projects/${focusProject.id}?job=bootstrap`,
              button: "解析ジョブを確認",
            }
          : null;
  const setupStep = !installations.length ? 2 : !projects.length ? 3 : !repositories.length ? 4 : 5;
  const setupLabels = ["Workspaceを作成", "GitHub Appを接続", "プロジェクトを作成", "リポジトリを追加", "初回解析を確認"];

  const humanReviewHref = `${root}/reviews?status=human_required`;
  const reviewUnreviewedHref = `${root}/reviews?status=unreviewed`;
  const affectedDriftProjects = overview.projects.filter((project) => project.openDriftCount > 0);
  const affectedPublicationProjects = overview.projects.filter((project) => project.unpublishedCount > 0);
  const confirmedPublicationProjects = overview.projects.filter((project) => project.publishedCount > 0);

  // A KPI only links directly to a project when all of its findings belong to it.
  const driftHref = affectedDriftProjects.length === 1 && !overview.unmatchedDriftCount
    ? `${root}/projects/${affectedDriftProjects[0].id}/drift` : "#projects";
  const unpublishedHref = affectedPublicationProjects.length === 1
    ? `${root}/projects/${affectedPublicationProjects[0].id}/publications` : "#projects";
  const publishedHref = confirmedPublicationProjects.length === 1
    ? `${root}/projects/${confirmedPublicationProjects[0].id}/publications` : "#projects";

  const actionItems: ActionItem[] = [];
  const addProjectAction = (project: WorkspaceProjectSummary, type: "human" | "unreviewed" | "drift" | "publication") => {
    const base = `${root}/projects/${project.id}`;
    const data = type === "human"
      ? { count: project.humanReviewCount, title: "人間確認", detail: "差分と根拠を確認し、承認の判断をしてください。", href: `${humanReviewHref}&project=${encodeURIComponent(project.id)}`, label: "レビューする", tone: "warning" as const }
      : type === "unreviewed"
        ? { count: project.unreviewedCount, title: "未評価", detail: "手動承認対象、または評価開始前の提案があります。", href: `${reviewUnreviewedHref}&project=${encodeURIComponent(project.id)}`, label: "未評価を確認", tone: "neutral" as const }
        : type === "drift"
          ? { count: project.openDriftCount, title: "未処理Drift", detail: "依存関係のずれと影響を確認してください。", href: `${base}/drift`, label: "ずれを確認", tone: "warning" as const }
          : { count: project.unpublishedCount, title: "承認済み・未反映", detail: "Draft PRと反映の検証状況を確認してください。", href: `${base}/publications`, label: "反映状況を確認", tone: "neutral" as const };
    if (data.count) actionItems.push({
      key: `${type}-${project.id}`,
      title: `${project.name}：${data.title} ${data.count}件`,
      description: data.detail, href: data.href, label: data.label, tone: data.tone,
    });
  };
  // Prioritize an actionable human decision over a background evaluation.
  for (const type of ["human", "unreviewed", "drift", "publication"] as const) {
    for (const project of overview.projects) addProjectAction(project, type);
  }
  const unassignedHuman = overview.humanReviewCount -
    overview.projects.reduce((sum, project) => sum + project.humanReviewCount, 0);
  const unassignedUnreviewed = overview.unreviewedCount -
    overview.projects.reduce((sum, project) => sum + project.unreviewedCount, 0);
  if (unassignedHuman > 0) actionItems.unshift({
    key: "human-workspace", title: `Workspace共通ルール：人間確認 ${unassignedHuman}件`,
    description: "差分と根拠を確認して判断してください。",
    href: humanReviewHref, label: "レビューする", tone: "warning",
  });
  if (unassignedUnreviewed > 0) actionItems.push({
    key: "unreviewed-workspace", title: `Workspace共通ルール：未評価 ${unassignedUnreviewed}件`,
    description: "手動承認対象、または評価開始前の提案があります。",
    href: reviewUnreviewedHref, label: "未評価を確認", tone: "neutral",
  });
  for (const project of overview.projects) {
    if (project.repositoryCount === 0 || bootstrapStatusByProject[project.id] !== "failed") continue;
    actionItems.push({
      key: `bootstrap-${project.id}`, title: `${project.name}：初回解析に失敗`,
      description: "直近の解析が失敗しました。ジョブの詳細から原因を確認してください。",
      href: `${root}/projects/${project.id}?job=bootstrap`, label: "解析ジョブを確認", tone: "warning",
    });
  }

  const kindLabel = workspace.kind === "personal" ? "個人Workspace" : "組織Workspace";
  const showOperationalSummary = initialized || overview.humanReviewCount > 0 ||
    overview.unreviewedCount > 0 || overview.evaluatingCount > 0 ||
    overview.openDriftCount > 0 || overview.unpublishedCount > 0 || overview.publishedCount > 0;

  return <main className="pageContainer workspaceOverview">
    <PageHeader
      eyebrow="ワークスペース概要"
      title={String(workspace.name)}
      description="確認が必要な提案と、承認したルールの反映状況をまとめて確認できます。"
      meta={<>
        <span className="workspaceMetaTag">{kindLabel}</span>
        <span className="workspaceMetaTag">プロジェクト {projects.length}</span>
        <span className="workspaceMetaTag">リポジトリ {repositories.length}</span>
        <span className="workspaceMetaTag">有効ルール {overview.activeRuleCount}</span>
      </>}
      actions={canManage && !setupPhase && <Link className="button secondary" href={`${root}/projects/new`}>プロジェクトを作成</Link>}
    />

    {workspace.demoMode === true && overview.projects[0] && <section className="workspaceDemoGuide" aria-labelledby="judge-demo-guide-title">
      <div className="workspaceDemoGuideCopy">
        <p className="workspaceDemoGuideEyebrow">HACKATHON JUDGE DEMO</p>
        <h2 id="judge-demo-guide-title">React 18 / Zod 3 → React 19 / Zod 4 のルール更新を追体験</h2>
        <p>このWorkspaceは審査用の閲覧専用環境です。コード変更からDrift検出、根拠付きAI提案、人間へのエスカレーション、Draft PRまでを順に確認できます。</p>
      </div>
      <nav className="workspaceDemoGuideSteps" aria-label="審査デモの確認順">
        <Link href={`${root}/projects/${overview.projects[0].id}/drift`}><span>01</span><strong>Driftを確認</strong><small>依存更新とEvidence</small></Link>
        <Link href={`${root}/reviews?status=human_required&project=${encodeURIComponent(overview.projects[0].id)}`}><span>02</span><strong>AI評価を確認</strong><small>人間へ引き継ぐ理由</small></Link>
        <Link href={`${root}/projects/${overview.projects[0].id}/publications`}><span>03</span><strong>反映を確認</strong><small>Draft PRと生成物</small></Link>
        <a href="https://github.com/yunbow/rule-branch-demo-workspace-1" target="_blank" rel="noreferrer"><span>GitHub</span><strong>デモRepository</strong><small>PR #1 / Draft PR #2 <ExternalLink size={12} aria-hidden="true"/></small></a>
      </nav>
    </section>}

    {setupPhase && setupDetails && <Card className="workspaceSetupCard">
      <div className="workspaceSetupCopy">
        <p className="workspaceSetupEyebrow">はじめに</p>
        <h2>{setupDetails.title}</h2>
        <p>{setupDetails.detail}</p>
        {canManage || setupPhase === "analysis"
          ? <Link className="button primary" href={setupDetails.href}>{setupDetails.button}<ArrowRight size={16} aria-hidden="true"/></Link>
          : <p className="workspaceSetupPermission">この設定は管理者に依頼してください。</p>}
      </div>
      <ol className="workspaceSetupSteps" aria-label="セットアップの進み具合">
        {setupLabels.map((label, index) =>
          <li key={label} className={index + 1 < setupStep ? "done" : index + 1 === setupStep ? "current" : ""}>
            <span className="workspaceSetupStepIcon">
              {index + 1 < setupStep ? <CheckCircle2 size={15} aria-hidden="true"/> : index + 1}
            </span>
            <span>{label}</span>
          </li>,
        )}
      </ol>
    </Card>}

    {showOperationalSummary && <>
      <section className="workspaceMetricsSection" aria-label="ワークスペースの対応状況">
        <div className="workspaceKpiGrid">
          <Link className={`workspaceKpiCard workspaceKpiLink${overview.humanReviewCount ? " needsAttention" : ""}`} href={humanReviewHref}>
            <span className="workspaceKpiIcon"><Inbox size={19} aria-hidden="true"/></span>
            <span>人間確認</span><strong>{overview.humanReviewCount}</strong>
            <small>承認の判断が必要</small>
          </Link>
          <Link className={`workspaceKpiCard workspaceKpiLink${overview.openDriftCount ? " needsAttention" : ""}`} href={driftHref}>
            <span className="workspaceKpiIcon"><AlertTriangle size={19} aria-hidden="true"/></span>
            <span>未処理Drift</span><strong>{overview.openDriftCount}</strong>
            <small>{affectedDriftProjects.length === 1 && !overview.unmatchedDriftCount ? "対象を確認" : "プロジェクト別に確認"}</small>
          </Link>
          <Link className={`workspaceKpiCard workspaceKpiLink${overview.unpublishedCount ? " needsAttention" : ""}`} href={unpublishedHref}>
            <span className="workspaceKpiIcon"><Clock3 size={19} aria-hidden="true"/></span>
            <span>承認済み・未反映</span><strong>{overview.unpublishedCount}</strong>
            <small>反映作業や検証を確認</small>
          </Link>
          <Link className="workspaceKpiCard workspaceKpiLink" href={publishedHref}>
            <span className="workspaceKpiIcon"><ShieldCheck size={19} aria-hidden="true"/></span>
            <span>反映確認済み</span><strong>{overview.publishedCount}</strong>
            <small>リポジトリへの反映を確認</small>
          </Link>
        </div>
        <p className="workspaceSummaryNote">
          レビューキュー：AI評価中 {overview.evaluatingCount}件 ・ 未評価 {overview.unreviewedCount}件。
          反映状況の件数はプロジェクトルールが対象で、AIがルールを守ったことの評価ではありません。
        </p>
      </section>

      <PageSection title="次に確認すること" description="差分・根拠を確認する画面へ移動します。" className="workspaceAttentionSection">
        {actionItems.length > 0 ? <>
          <div className="workspaceAttentionList">
            {actionItems.slice(0, 5).map((item) => <article className={`workspaceAttentionRow ${item.tone}`} key={item.key}>
              <span className="workspaceAttentionIcon" aria-hidden="true">{item.tone === "warning" ? <AlertTriangle size={19}/> : <Inbox size={19}/>}</span>
              <div className="workspaceAttentionCopy"><h3>{item.title}</h3><p>{item.description}</p></div>
              <Link className="workspaceAttentionAction" href={item.href}>{item.label}<ArrowRight size={15} aria-hidden="true"/></Link>
            </article>)}
          </div>
          {actionItems.length > 5 && <p className="workspaceMoreActions">
            他に{actionItems.length - 5}項目あります。<Link href="#projects">プロジェクト別の状況を見る</Link>
          </p>}
        </> : overview.unmatchedDriftCount > 0 ? <div className="workspaceUnmatchedNotice">
          プロジェクトを特定できない未処理Driftがあります。対象プロジェクトが不明のため、個別画面への直接リンクは表示できません。
        </div> : <div className="workspaceAllClear">
          <CheckCircle2 size={21} aria-hidden="true"/>
          <div><strong>今すぐ確認する項目はありません</strong>
            <p>{overview.evaluatingCount ? `AI評価中の提案が${overview.evaluatingCount}件あります。判定後に再確認してください。`
              : "登録されているレビューキューと未処理Drift、未反映の項目はありません。"}</p>
          </div>
        </div>}
        {overview.unmatchedDriftCount > 0 && actionItems.length > 0 && <p className="workspaceUnmatchedNotice">
          プロジェクトを特定できない未処理Driftが{overview.unmatchedDriftCount}件あります。対象を特定できないため、個別画面へのリンクは表示していません。
        </p>}
      </PageSection>
    </>}

    <PageSection
      title="プロジェクト"
      description="プロジェクトごとの要対応・ルール・反映状況を確認できます。"
      className="workspaceProjectsSection"
      actions={canManage && <Link className="workspaceTextAction" href={`${root}/projects/new`}>+ プロジェクトを作成</Link>}
    >
      <div id="projects" className="workspaceProjectAnchor">
        {overview.projects.length
          ? <ProjectGrid
              workspaceId={workspaceId}
              projects={overview.projects}
              bootstrapStatusByProject={bootstrapStatusByProject}
              canManage={canManage}
            />
          : <div className="workspaceEmpty">まだプロジェクトがありません。{canManage
            ? <Link href={installations.length ? `${root}/projects/new` : `${root}/install`}>設定を始める</Link>
            : <span>管理者による設定が必要です。</span>}</div>}
      </div>
    </PageSection>
  </main>;
}
