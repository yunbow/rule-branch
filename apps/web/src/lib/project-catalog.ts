import type { BootstrapStatus, WorkspaceProjectSummary } from "./workspace-overview.ts";

export type CatalogProject = WorkspaceProjectSummary;
export type CatalogFilter = "all" | "action" | "setup" | "clear";
export type CatalogSort = "priority" | "name" | "newest";

export function needsProjectAction(project: CatalogProject, bootstrap?: BootstrapStatus): boolean {
  return project.humanReviewCount > 0 ||
    project.unreviewedCount > 0 ||
    project.openDriftCount > 0 ||
    project.candidateCount > 0 ||
    (project.publicationAvailable && project.unpublishedCount > 0) ||
    bootstrap === "failed";
}

export function isProjectSetupPending(project: CatalogProject, bootstrap?: BootstrapStatus): boolean {
  return project.repositoryCount === 0 ||
    bootstrap === "not_started" || bootstrap === "running" || bootstrap === "failed";
}

/** Do not label projects healthy when bootstrap/publication data was not loaded. */
export function hasNoProjectActions(project: CatalogProject, bootstrap?: BootstrapStatus): boolean {
  return project.repositoryCount > 0 &&
    bootstrap === "done" &&
    project.publicationAvailable &&
    !needsProjectAction(project, bootstrap) &&
    project.evaluatingCount === 0;
}

function priority(project: CatalogProject, bootstrap?: BootstrapStatus): number {
  if (project.humanReviewCount > 0) return 0;
  if (project.unreviewedCount > 0) return 1;
  if (project.openDriftCount > 0) return 2;
  if (project.publicationAvailable && project.unpublishedCount > 0) return 3;
  if (bootstrap === "failed") return 4;
  if (project.candidateCount > 0) return 5;
  if (isProjectSetupPending(project, bootstrap)) return 6;
  if (project.evaluatingCount > 0) return 7;
  if (hasNoProjectActions(project, bootstrap)) return 8;
  return 9;
}

export function filterAndSortProjects({
  projects,
  bootstrapStatusByProject,
  search = "",
  filter = "all",
  sort = "priority",
}: {
  projects: CatalogProject[];
  bootstrapStatusByProject: Record<string, BootstrapStatus>;
  search?: string;
  filter?: CatalogFilter;
  sort?: CatalogSort;
}): CatalogProject[] {
  const query = search.trim().toLocaleLowerCase("ja");
  return projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => {
      const bootstrap = bootstrapStatusByProject[project.id];
      const matchesQuery = !query || [project.name, project.slug, project.description ?? ""]
        .some((value) => value.toLocaleLowerCase("ja").includes(query));
      if (!matchesQuery) return false;
      if (filter === "action") return needsProjectAction(project, bootstrap);
      if (filter === "setup") return isProjectSetupPending(project, bootstrap);
      if (filter === "clear") return hasNoProjectActions(project, bootstrap);
      return true;
    })
    .sort((a, b) => {
      let difference = 0;
      if (sort === "name") difference = a.project.name.localeCompare(b.project.name, "ja");
      else if (sort === "newest") {
        const aTime = Date.parse(a.project.createdAt ?? "") || 0;
        const bTime = Date.parse(b.project.createdAt ?? "") || 0;
        difference = bTime - aTime;
      } else difference = priority(a.project, bootstrapStatusByProject[a.project.id]) -
        priority(b.project, bootstrapStatusByProject[b.project.id]);
      return difference || a.index - b.index;
    })
    .map(({ project }) => project);
}
