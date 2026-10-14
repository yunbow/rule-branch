import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectRuleSummary } from "../../../../../components/domain/ProjectRuleSummary.tsx";
import { ProjectHeaderTags } from "../../../../../components/domain/ProjectHeaderTags.tsx";
import { projectRuleSummary } from "../../../../../lib/project-rule-summary.ts";
import { getProjectNextActions } from "../../../../../lib/project-overview.ts";
import { ProjectOverview } from "../../../../../components/domain/ProjectOverview.tsx";
import { JobList } from "../../../../../components/domain/JobList.tsx";
import { JobProgress, type JobView } from "../../../../../components/domain/JobProgress.tsx";
import { ProjectDeleteSection } from "../../../../../components/domain/ProjectDeleteSection.tsx";
import { ProjectNav } from "../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader, PageSection } from "../../../../../components/ui/Page.tsx";
import { getSessionUser } from "../../../../../server/session.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../../../../shared/permissions.ts";
import { getProjectJobs, getWorkspaceAccess } from "../../../../../server/queries.ts";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const { job } = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.projectRepositories || !runtime.rules) notFound();

  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  const [project, repositories, installations, jobs, revisionPrs, rules] = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, uid, projectId),
    runtime.projectRepositories.listRepositories(workspaceId, uid, projectId),
    runtime.store.list({ workspaceId, actorUserId: uid }, "installations", { status: "active" }),
    getProjectJobs(workspaceId, uid, projectId),
    runtime.projectRepositories.listRevisionPrs(workspaceId, uid),
    runtime.store.list({ workspaceId, actorUserId: uid }, "rules", { projectId }),
  ]);

  // Unlinked repositories remain in the audit trail, but must not appear connected.
  const linkedRepositories = repositories.filter((item) => item.status !== "removed" && !item.deletedAt);
  const activeRepositories = linkedRepositories.filter((item) => item.status === "active");
  const sortedJobs = [...jobs].sort(
    (a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  ) as JobView[];

  const repoIds = new Set(linkedRepositories.map((item) => String(item.id)));
  const draftPrCount = revisionPrs.filter(
    (item) => repoIds.has(String(item.repositoryId)) && item.status === "draft_open",
  ).length;
  const activeJobCount = sortedJobs.filter((item) =>
    item.status === "queued" || item.status === "running").length;
  const versionIds = rules.filter((rule) => ["active", "stale"].includes(String(rule.status)))
    .map((rule) => rule.currentVersionId).filter((id): id is string => typeof id === "string");
  const publicationStates = versionIds.length
    ? await runtime.rules.getPublicationStates(workspaceId, uid, versionIds)
    : {};
  const counts = projectRuleSummary(
    rules,
    publicationStates,
    new Set(activeRepositories.map((item) => String(item.id))),
  );
  const totalRuleCount = rules.filter((rule) =>
    !rule.deletedAt && ["draft", "active", "stale"].includes(String(rule.status)),
  ).length;

  const canManage = hasWorkspacePermission(
    workspace.kind as WorkspaceKind,
    membership.role as WorkspaceRole,
    "admin",
  );
  const runningJob = sortedJobs.find((item) => ["queued", "running"].includes(item.status));
  const latestJobFailed = ["failed", "dead"].includes(sortedJobs[0]?.status ?? "");
  // Keep the initial-bootstrap deep link useful even when its job has finished.
  const featured = runningJob ?? (job === "bootstrap"
    ? sortedJobs.find((item) => item.type === "bootstrap")
    : undefined);
  const base = "/w/" + workspaceId + "/projects/" + projectId;
  const nextActions = getProjectNextActions({
    basePath: base,
    repositoryCount: linkedRepositories.length,
    activeRepositoryCount: activeRepositories.length,
    canManageRepositories: canManage,
    jobCount: sortedJobs.length,
    activeJobCount,
    latestJobFailed,
    counts,
  });
  const projectMeta = [
    ...((project.primaryLanguages as string[] | undefined) ?? []),
    ...((project.frameworks as string[] | undefined) ?? []),
    ...((project.focusThemes as string[] | undefined) ?? []),
  ];

  return <main className="pageContainer projectPage">
    <Breadcrumbs>
      <Link href={"/w/" + workspaceId}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>{String(project.name)}</span>
    </Breadcrumbs>

    <PageHeader
      eyebrow="プロジェクト概要"
      title={String(project.name)}
      description="ルールの確認からGitHubへの反映までを管理します。"
      meta={<ProjectHeaderTags tags={projectMeta}/>}
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>

    <section className="projectActionCallout" aria-labelledby="project-next-action-heading">
      <div className="projectActionCopy">
        <p className="projectActionEyebrow">NEXT ACTION</p>
        <h2 id="project-next-action-heading">次に確認すること</h2>
        <p className="projectActionDescription">{nextActions.primary.description}</p>
        {nextActions.secondary && <Link className="projectActionSecondary" href={nextActions.secondary.href}>
          ほかに {nextActions.secondary.shortLabel} <span aria-hidden="true">→</span>
        </Link>}
      </div>
      <Link className="button primary projectActionButton" href={nextActions.primary.href}>
        {nextActions.primary.label}<span aria-hidden="true">→</span>
      </Link>
    </section>

    <ProjectRuleSummary
      workspaceId={workspaceId}
      projectId={projectId}
      counts={counts}
      totalRules={totalRuleCount}
      draftPrCount={draftPrCount}
    />

    {featured && <section id="active-job" className="projectSectionAnchor projectActiveJobSection"
      aria-labelledby="project-featured-job-heading">
      <header className="projectInlineSectionHeader">
        <div>
          <h2 id="project-featured-job-heading">{runningJob ? "実行中の処理" : "初回解析の結果"}</h2>
          {runningJob && activeJobCount > 1 && <p>ほかに実行中の処理が{activeJobCount - 1}件あります。</p>}
        </div>
        <Link href="#jobs">すべての処理を見る <span aria-hidden="true">→</span></Link>
      </header>
      <JobProgress job={featured} workspaceId={workspaceId} compact/>
    </section>}

    <div id="repositories" className="projectSectionAnchor"><ProjectOverview
      workspaceId={workspaceId}
      projectId={projectId}
      repositories={linkedRepositories.map((item) => ({
        id: String(item.id),
        fullName: String(item.fullName),
        defaultBranch: typeof item.defaultBranch === "string" ? item.defaultBranch : undefined,
        status: String(item.status),
      }))}
      installations={installations.map((item) => ({
        id: String(item.id),
        githubInstallationId: String(item.githubInstallationId),
        accountLogin: typeof item.accountLogin === "string" ? item.accountLogin : undefined,
        repositorySelection: String(item.repositorySelection),
      }))}
      canManage={canManage}
    /></div>

    <div id="jobs" className="projectSectionAnchor"><PageSection
      title="最近の処理"
      description="初回解析・ずれの検知・改定提案・生成の履歴を確認できます。"
      className="projectJobHistorySection">
      <JobList
        jobs={sortedJobs}
        workspaceId={workspaceId}
        projectId={projectId}
        externallyPolledJobId={featured?.id}
      />
    </PageSection></div>

    {canManage && <ProjectDeleteSection
      workspaceId={workspaceId}
      projectId={projectId}
      projectName={String(project.name)}
      demoMode={workspace.demoMode === true}
    />}
  </main>;
}
