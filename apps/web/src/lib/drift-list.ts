import { getStatusLabel } from "./labels.ts";
import { canTriage, canWrite, type WorkspaceKind, type WorkspaceRole } from "../shared/permissions.ts";

const severityRank: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3 };
export const STALE_THRESHOLD = { minimumSeverity: "medium", minimumConfidence: 0.6 } as const;

export function driftTypeLabel(value: string) { return getStatusLabel("driftType", value).label; }
export function severityLabel(value: string) { return getStatusLabel("severity", value).label; }
export function isBelowStaleThreshold(severity: string, confidence: number): boolean {
  return (severityRank[severity] ?? -1) < severityRank[STALE_THRESHOLD.minimumSeverity] || confidence < STALE_THRESHOLD.minimumConfidence;
}
export function driftActionPermissions(kind: WorkspaceKind, role: WorkspaceRole) {
  return { triage: canTriage(kind, role), manualTrigger: canWrite(kind, role) };
}
