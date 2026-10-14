export type RelationType = "override" | "extend" | "deny";

export type RelationRule = {
  id: string;
  title: string;
  scopeType: string;
  status: string;
  projectId?: string | null;
};

const selectableStatuses = new Set(["active", "stale", "draft"]);

export function parentRelationRules<T extends RelationRule>(rules: T[]): T[] {
  return rules.filter((rule) => rule.scopeType === "organization" && selectableStatuses.has(rule.status));
}

export function childRelationRules<T extends RelationRule>(rules: T[]): T[] {
  return rules.filter((rule) => rule.scopeType === "project" && selectableStatuses.has(rule.status));
}

export function relationRationaleError(relationType: RelationType, rationale: string): string | null {
  if (relationType === "deny" && (!rationale.trim() || rationale.length > 2000)) return "RELATION_RATIONALE_REQUIRED";
  return null;
}
