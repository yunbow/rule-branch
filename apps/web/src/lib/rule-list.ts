export type RuleTab = "all" | "draft" | "stale" | "active" | "other";
/** rules.type is the DM-defined enum (policy/guideline/workflow/architecture/security/coding-style/interaction), never scopeType. */
export type RuleFilterable = { title: string; key: string; layer: string; enforcement: string; status: string; type: string };
export type RuleFilters = { layer: string; enforcement: string; type: string; query: string };
export function filterRules<T extends RuleFilterable>(rules: T[], tab: RuleTab, filters: RuleFilters): T[] {
  return rules.filter((rule) => (tab === "all" || tab === "other" ? (tab !== "other" || !["draft", "stale", "active"].includes(rule.status)) : rule.status === tab) && (!filters.layer || rule.layer === filters.layer) && (!filters.enforcement || rule.enforcement === filters.enforcement) && (!filters.type || rule.type === filters.type) && (!filters.query || `${rule.title} ${rule.key}`.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())));
}
