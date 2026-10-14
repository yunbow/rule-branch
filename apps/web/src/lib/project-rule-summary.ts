export type ProjectRuleDocument = Record<string, unknown>;

/** Counts current project rules only, using applicable active repositories. */
export function projectRuleSummary(rules: ProjectRuleDocument[], publicationStates: Record<string, ProjectRuleDocument>, repositoryIds: Set<string>) {
  let candidates = 0, stale = 0, unpublished = 0, published = 0;
  for (const rule of rules) {
    if (rule.deletedAt || ["archived", "deprecated", "superseded"].includes(String(rule.status))) continue;
    if (rule.status === "draft") candidates += 1;
    if (rule.status === "stale") stale += 1;
    if (!["active", "stale"].includes(String(rule.status)) || typeof rule.currentVersionId !== "string" || rule.enforcement === "personal") continue;
    const state = publicationStates[rule.currentVersionId];
    const targets = Array.isArray(state?.perRepository)
      ? (state.perRepository as ProjectRuleDocument[]).filter((item) => repositoryIds.has(String(item.repositoryId)))
      : [];
    // A selector with no matching repositories is not a pending publication.
    if (!targets.length) continue;
    if (targets.every((item) => item.state === "published")) published += 1;
    else unpublished += 1;
  }
  return { candidates, stale, unpublished, published };
}
