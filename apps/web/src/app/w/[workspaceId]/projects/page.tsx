import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { ProjectCatalog } from "../../../../components/domain/ProjectCatalog.tsx";
import { getBootstrapStatus, summarizeWorkspace, type BootstrapStatus, type OverviewRecord } from "../../../../lib/workspace-overview.ts";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { getProjects, getRules, getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { listProjectJobs } from "../../../../shared/analysis-jobs.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../../../shared/permissions.ts";

export default async function ProjectsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
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
  const [rawProjects, installations, rawRepositories, rawRules, rawReviews, rawFindings] = await Promise.all([
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
  const projectIds = new Set(projects.map((project) => String(project.id)));
  const projectWithRepos = [...new Set(repositories.map((repo) => String(repo.projectId ?? "")))]
    .filter((id) => projectIds.has(id));
  const versionIds = [...new Set(rules
    .filter((rule) => projectIds.has(String(rule.projectId ?? "")) &&
      !rule.deletedAt && ["active", "stale"].includes(String(rule.status)) &&
      typeof rule.currentVersionId === "string")
    .map((rule) => rule.currentVersionId as string))];

  // Match the overview dashboard's selector-aware publication and bootstrap definitions.
  const [publicationStates, bootstrapEntries] = await Promise.all([
    runtime.rules && versionIds.length
      ? runtime.rules.getPublicationStates(workspaceId, userId, versionIds)
      : Promise.resolve({} as Record<string, OverviewRecord>),
    Promise.all(projectWithRepos.map(async (projectId) => {
      const jobs = await listProjectJobs(store, ctx, projectId, { type: "bootstrap", limit: 1 });
      return [projectId, getBootstrapStatus(jobs[0] as OverviewRecord | undefined)] as const;
    })),
  ]);
  const bootstrapStatusByProject: Record<string, BootstrapStatus> = Object.fromEntries(bootstrapEntries);
  const overview = summarizeWorkspace({
    projects,
    repositories,
    rules,
    reviews: rawReviews as OverviewRecord[],
    findings: rawFindings as OverviewRecord[],
    publicationStates: runtime.rules ? publicationStates : undefined,
  });

  const eligibleInstallations = installations.filter((item) => item.repositorySelection === "selected");
  const createHref = eligibleInstallations.length
    ? `/w/${workspaceId}/projects/new`
    : `/w/${workspaceId}/install`;
  const createLabel = eligibleInstallations.length ? "プロジェクトを作成" : "GitHub Appを接続";

  return <main className="pageContainer projectsCatalogPage">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>プロジェクト一覧</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="プロジェクト管理"
      title="プロジェクト一覧"
      description="プロジェクトを探して、ルールの確認・解析・反映状況へ進めます。"
      meta={<span className="projectCatalogHeaderCount">全{projects.length}件のプロジェクト</span>}
      actions={canManage && <Link className="button primary" href={createHref}><Plus size={17} aria-hidden="true"/>{createLabel}</Link>}
    />
    {projects.length
      ? <ProjectCatalog
          workspaceId={workspaceId}
          projects={overview.projects}
          canManage={canManage}
          bootstrapStatusByProject={bootstrapStatusByProject}
        />
      : <section className="projectCatalogInitialEmpty">
          <h2>まだプロジェクトがありません</h2>
          <p>GitHubのリポジトリからルール候補を抽出し、開発ルールの管理を始められます。</p>
          {canManage
            ? <Link className="button primary" href={createHref}>{createLabel}</Link>
            : <p>プロジェクトの作成にはWorkspace管理者の権限が必要です。</p>}
        </section>}
  </main>;
}
