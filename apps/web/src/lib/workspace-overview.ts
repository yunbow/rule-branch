import { projectRuleSummary } from "./project-rule-summary.ts";

export type OverviewRecord = Record<string, unknown>;
export type ReviewState = "human_required" | "evaluating" | "unreviewed";
export type BootstrapStatus = "not_started" | "running" | "failed" | "done";

export function getReviewState(version: OverviewRecord): ReviewState {
  const review = version.approvalReview as OverviewRecord | undefined;
  if (review?.state === "human_required") return "human_required";
  if (review?.state === "evaluating") return "evaluating";
  return "unreviewed";
}

export function getBootstrapStatus(job?: OverviewRecord | null): BootstrapStatus {
  if (job?.status === "done") return "done";
  if (job?.status === "queued" || job?.status === "running") return "running";
  if (job?.status === "failed" || job?.status === "dead") return "failed";
  return "not_started";
}

export type WorkspaceProjectSummary = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  createdAt?: string;
  repositoryCount: number;
  activeRuleCount: number;
  humanReviewCount: number;
  evaluatingCount: number;
  unreviewedCount: number;
  openDriftCount: number;
  candidateCount: number;
  unpublishedCount: number;
  publishedCount: number;
  publicationAvailable: boolean;
};

export type WorkspaceOverviewSummary = {
  projects: WorkspaceProjectSummary[];
  activeRuleCount: number;
  humanReviewCount: number;
  evaluatingCount: number;
  unreviewedCount: number;
  openDriftCount: number;
  unmatchedDriftCount: number;
  unpublishedCount: number;
  publishedCount: number;
};

/** One source of truth for Workspace KPI, attention links, and Project cards. */
export function summarizeWorkspace({
  projects,
  repositories,
  rules,
  reviews,
  findings,
  publicationStates,
}: {
  projects: OverviewRecord[];
  repositories: OverviewRecord[];
  rules: OverviewRecord[];
  reviews: OverviewRecord[];
  findings: OverviewRecord[];
  publicationStates?: Record<string, OverviewRecord>;
}): WorkspaceOverviewSummary {
  const summaries = projects.map((project): WorkspaceProjectSummary => ({
    id: String(project.id),
    name: String(project.name),
    slug: String(project.slug ?? ""),
    description: typeof project.description === "string" ? project.description : undefined,
    createdAt: typeof project.createdAt === "string" ? project.createdAt : undefined,
    repositoryCount: 0,
    activeRuleCount: 0,
    humanReviewCount: 0,
    evaluatingCount: 0,
    unreviewedCount: 0,
    openDriftCount: 0,
    candidateCount: 0,
    unpublishedCount: 0,
    publishedCount: 0,
    publicationAvailable: publicationStates !== undefined,
  }));
  const byProject = new Map(summaries.map((item) => [item.id, item]));
  const byRule = new Map(rules.map((rule) => [String(rule.id), rule]));
  const repositoriesByProject = new Map<string, Set<string>>();
  const rulesByProject = new Map<string, OverviewRecord[]>();

  for (const repository of repositories) {
    const projectId = String(repository.projectId ?? "");
    const summary = byProject.get(projectId);
    if (!summary || repository.status !== "active") continue;
    summary.repositoryCount += 1;
    const ids = repositoriesByProject.get(projectId) ?? new Set<string>();
    ids.add(String(repository.id));
    repositoriesByProject.set(projectId, ids);
  }
  for (const rule of rules) {
    if (rule.deletedAt) continue;
    const projectId = typeof rule.projectId === "string" ? rule.projectId : "";
    const summary = byProject.get(projectId);
    if (!summary) continue;
    if (rule.status === "active") summary.activeRuleCount += 1;
    if (rule.status === "draft") summary.candidateCount += 1;
    const group = rulesByProject.get(projectId) ?? [];
    group.push(rule);
    rulesByProject.set(projectId, group);
  }

  let humanReviewCount = 0, evaluatingCount = 0, unreviewedCount = 0;
  for (const version of reviews) {
    const rule = byRule.get(String(version.ruleId));
    // The reviews page also excludes versions whose rule is unavailable.
    if (!rule || rule.deletedAt) continue;
    const state = getReviewState(version);
    if (state === "human_required") humanReviewCount += 1;
    else if (state === "evaluating") evaluatingCount += 1;
    else unreviewedCount += 1;
    const summary = byProject.get(typeof rule.projectId === "string" ? rule.projectId : "");
    if (!summary) continue; // organization-level proposals remain in Workspace totals
    if (state === "human_required") summary.humanReviewCount += 1;
    else if (state === "evaluating") summary.evaluatingCount += 1;
    else summary.unreviewedCount += 1;
  }

  let openDriftCount = 0, unmatchedDriftCount = 0;
  for (const finding of findings) {
    if (finding.status !== "open") continue;
    openDriftCount += 1;
    const direct = [finding.projectId, finding.scopeId].find(
      (id) => typeof id === "string" && byProject.has(id),
    ) as string | undefined;
    const rule = byRule.get(String(finding.ruleId));
    const related = typeof rule?.projectId === "string" ? rule.projectId : undefined;
    const summary = byProject.get(direct ?? related ?? "");
    if (summary) summary.openDriftCount += 1;
    else unmatchedDriftCount += 1;
  }

  if (publicationStates !== undefined) {
    for (const summary of summaries) {
      const counts = projectRuleSummary(
        rulesByProject.get(summary.id) ?? [],
        publicationStates,
        repositoriesByProject.get(summary.id) ?? new Set<string>(),
      );
      summary.candidateCount = counts.candidates;
      summary.unpublishedCount = counts.unpublished;
      summary.publishedCount = counts.published;
    }
  }

  return {
    projects: summaries,
    activeRuleCount: rules.filter((rule) => !rule.deletedAt && rule.status === "active").length,
    humanReviewCount, evaluatingCount, unreviewedCount, openDriftCount, unmatchedDriftCount,
    unpublishedCount: summaries.reduce((total, item) => total + item.unpublishedCount, 0),
    publishedCount: summaries.reduce((total, item) => total + item.publishedCount, 0),
  };
}

/** Group projects needing action above healthy projects; preserve input order for ties. */
export function sortWorkspaceProjects(projects: WorkspaceProjectSummary[]): WorkspaceProjectSummary[] {
  const rank = (item: WorkspaceProjectSummary) =>
    item.humanReviewCount > 0 ? 0 :
    item.unreviewedCount > 0 ? 1 :
    item.openDriftCount > 0 ? 2 :
    item.unpublishedCount > 0 ? 3 : 4;
  return [...projects].sort((a, b) => rank(a) - rank(b));
}
