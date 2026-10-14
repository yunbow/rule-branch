export type ProjectRuleReference = { id: string; projectId: string | null };
export type DecisionMemoryReference = {
  linkedRuleIds: string[];
  projectId?: string | null;
  deletedAt?: string | null;
};

export type DecisionMemoryRecord = DecisionMemoryReference & {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  createdAt: string;
  approvedRuleVersionId?: string | null;
  approvedRuleVersionNumber?: number | null;
  approvedChangeType?: string | null;
  approvalComment?: string | null;
  approvalMode?: "human" | "automatic" | null;
  linkedEvidenceIds?: string[];
};

export type DecisionPeriod = "all" | "7" | "30" | "90";
export type DecisionSort = "newest" | "oldest";
export type DecisionView = "timeline" | "rule";

export const DECISION_PAGE_SIZE = 10;

/**
 * A persisted project ID is authoritative, even when a rule is subsequently
 * archived, deleted, or no longer returned by the live rule API.
 * Legacy records without a project ID retain the original linked-rule fallback.
 * A mismatching persisted project ID is never overridden by the fallback.
 */
export function filterDecisionMemoriesForProject<T extends DecisionMemoryReference>(
  memories: readonly T[], rules: readonly ProjectRuleReference[], projectId: string,
): T[] {
  const ruleProjects = new Map(rules.map((rule) => [rule.id, rule.projectId]));
  return memories.filter((memory) => {
    if (memory.deletedAt) return false;
    if (typeof memory.projectId === "string" && memory.projectId.length > 0)
      return memory.projectId === projectId;
    return memory.linkedRuleIds.some((ruleId) => ruleProjects.get(ruleId) === projectId);
  });
}

function dateValue(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function countDecisionMemories<T extends Pick<DecisionMemoryRecord, "createdAt" | "linkedRuleIds">>(
  memories: readonly T[], now: number,
): { total: number; recent30Days: number; relatedRules: number } {
  const threshold = now - 30 * 24 * 60 * 60 * 1000;
  return {
    total: memories.length,
    recent30Days: memories.filter((memory) => {
      const value = dateValue(memory.createdAt);
      return value !== null && value >= threshold && value <= now;
    }).length,
    relatedRules: new Set(memories.flatMap((memory) => memory.linkedRuleIds)).size,
  };
}

export function filterAndSortDecisionMemories<T extends DecisionMemoryRecord>(
  memories: readonly T[],
  options: {
    query?: string;
    ruleId?: string;
    period?: DecisionPeriod;
    sort?: DecisionSort;
    now: number;
    ruleTitles?: Readonly<Record<string, string>>;
  },
): T[] {
  const query = (options.query ?? "").trim().toLocaleLowerCase("ja");
  const period = options.period ?? "all";
  const threshold = period === "all" ? null
    : options.now - Number(period) * 24 * 60 * 60 * 1000;
  const byFilters = memories.filter((memory) => {
    if (options.ruleId && !memory.linkedRuleIds.includes(options.ruleId)) return false;
    if (threshold !== null) {
      const date = dateValue(memory.createdAt);
      if (date === null || date < threshold || date > options.now) return false;
    }
    if (!query) return true;
    const searchable = [
      memory.title, memory.context, memory.decision, memory.consequences,
      memory.approvalComment ?? "",
      ...memory.linkedRuleIds.map((id) => options.ruleTitles?.[id] ?? ""),
    ].join(" ").toLocaleLowerCase("ja");
    return searchable.includes(query);
  });
  const direction = options.sort === "oldest" ? 1 : -1;
  return byFilters.sort((a, b) => {
    const aDate = dateValue(a.createdAt) ?? 0;
    const bDate = dateValue(b.createdAt) ?? 0;
    return direction * (aDate - bDate) || a.id.localeCompare(b.id);
  });
}

export function groupDecisionMemories<T extends DecisionMemoryRecord>(
  memories: readonly T[],
  ruleTitles: Readonly<Record<string, string>>,
): Array<{ ruleId: string; title: string; memories: T[] }> {
  const groups = new Map<string, { ruleId: string; title: string; memories: T[] }>();
  for (const memory of memories) {
    const ruleId = memory.linkedRuleIds.find((id) =>
      Object.prototype.hasOwnProperty.call(ruleTitles, id))
      ?? memory.linkedRuleIds[0] ?? "";
    const groupKey = ruleId || "__unlinked__";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        ruleId,
        title: ruleTitles[ruleId] ?? (ruleId ? "以前の関連ルール（現在は確認できません）" : "関連ルール未特定"),
        memories: [],
      };
      groups.set(groupKey, group);
    }
    group.memories.push(memory);
  }
  return [...groups.values()];
}

export function formatDecisionDate(value: string): string {
  const time = dateValue(value);
  if (time === null) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium" })
    .format(new Date(time));
}
