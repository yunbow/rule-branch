export type FindingFilterItem = {
  status?: unknown;
  driftType?: unknown;
  path?: unknown;
  artifactPath?: unknown;
  filePath?: unknown;
  changedPath?: unknown;
};

export function matchesFindingPath(finding: FindingFilterItem, path: string): boolean {
  return [finding.path, finding.artifactPath, finding.filePath, finding.changedPath]
    .some((value) => typeof value === "string" && value === path);
}

export function filterFindings<T extends FindingFilterItem>(
  findings: T[], statuses: string[], type = "", path = "",
): { visible: T[]; pathMatched: boolean } {
  const byCategory = findings.filter((item) =>
    statuses.includes(String(item.status ?? "")) && (!type || item.driftType === type));
  if (!path) return { visible: byCategory, pathMatched: false };
  const exact = byCategory.filter((item) => matchesFindingPath(item, path));
  return exact.length
    ? { visible: exact, pathMatched: true }
    : { visible: byCategory, pathMatched: false };
}
