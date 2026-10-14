import type { FindingFilterItem } from "./drift-filter.ts";

export type DriftSort = "priority" | "recent" | "confidence";

export type DriftPresentationFinding = FindingFilterItem & {
  id?: unknown;
  ruleId?: unknown;
  repositoryId?: unknown;
  severity?: unknown;
  confidence?: unknown;
  summary?: unknown;
  detail?: unknown;
  createdAt?: unknown;
};

export type DriftDisplayOptions = {
  search?: string;
  severity?: string;
  repositoryId?: string;
  sort?: DriftSort;
};

const severityRank: Record<string, number> = { high: 3, medium: 2, low: 1, info: 0 };

export function formatDriftDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
  }).format(new Date(value));
}

function severityScore(value: unknown): number {
  return severityRank[String(value ?? "")] ?? -1;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusPriority(value: unknown): number {
  return value === "open" ? 2 : value === "accepted" ? 1 : 0;
}

/**
 * Presentation-only filtering. Existing type/status/path deep-link semantics
 * remain in filterFindings, applied before calling this helper.
 */
export function presentDriftFindings<T extends DriftPresentationFinding>(
  findings: readonly T[],
  options: DriftDisplayOptions,
  ruleTitles: Readonly<Record<string, string>> = {},
): T[] {
  const query = (options.search ?? "").trim().toLocaleLowerCase();
  const match = findings.filter((finding) => {
    if (options.severity && finding.severity !== options.severity) return false;
    if (options.repositoryId && finding.repositoryId !== options.repositoryId) return false;
    if (!query) return true;
    const text = [
      ruleTitles[String(finding.ruleId ?? "")] ?? "",
      finding.summary, finding.detail, finding.driftType,
      finding.path, finding.artifactPath, finding.filePath, finding.changedPath,
    ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
    return text.includes(query);
  });

  const mode = options.sort ?? "priority";
  return match.sort((a, b) => {
    const dateDelta = timestamp(b.createdAt) - timestamp(a.createdAt);
    const confidenceDelta = confidence(b.confidence) - confidence(a.confidence);
    const severityDelta = severityScore(b.severity) - severityScore(a.severity);
    if (mode === "recent") return dateDelta || severityDelta || statusPriority(b.status) - statusPriority(a.status) || String(a.id).localeCompare(String(b.id));
    if (mode === "confidence") return confidenceDelta || severityDelta || dateDelta || String(a.id).localeCompare(String(b.id));
    return severityDelta || statusPriority(b.status) - statusPriority(a.status) || dateDelta || confidenceDelta || String(a.id).localeCompare(String(b.id));
  });
}

export function countDriftStatus(findings: readonly { status: unknown }[]) {
  return {
    open: findings.filter((finding) => finding.status === "open").length,
    accepted: findings.filter((finding) => finding.status === "accepted").length,
  };
}
