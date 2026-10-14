import type { ApprovalScanResult } from "./automatic-approval.ts";

// Only application-owned codes may become log keys. Provider errors can contain
// source text, credentials or unbounded values even when wrapped in an Error.
const EVALUATION_FAILURE_CODES = new Set([
  "GOOGLE_API_UNAVAILABLE", "GOOGLE_API_ERROR", "INVALID_PROVIDER_RESPONSE",
  "MODEL_ARMOR_BLOCKED_OR_INCOMPLETE", "GOOGLE_APPROVAL_NOT_CONFIGURED",
  "REVIEW_INPUT_TOO_LARGE", "GEMINI_BLOCKED", "INVALID_GEMINI_RESPONSE",
  "GEMINI_INCOMPLETE", "INVALID_EVALUATION_RESPONSE",
]);
export function safeEvaluationFailureCode(code: unknown): string {
  return typeof code === "string" && EVALUATION_FAILURE_CODES.has(code) ? code : "EVALUATION_FAILED";
}
export interface ApprovalScanDiagnostics {
  evaluationFailures: number;
  evaluationApiFailures: number;
  compilationFailures: number;
  evaluationFailureReasons: Record<string, number>;
}
export type ApprovalScanLog = {
  severity: "INFO" | "WARNING" | "ERROR";
  event: "approval_scan_started" | "approval_scan_completed" | "approval_scan_failed";
  scanId: string;
  mode: string;
  policyVersion: string;
  durationMs?: number;
  errorCode?: "APPROVAL_SCAN_FAILED";
} & Partial<Omit<ApprovalScanResult, "mode" | "policyVersion">> & Partial<ApprovalScanDiagnostics>;
export type ApprovalScanLogger = (entry: ApprovalScanLog) => void;
export const writeApprovalScanLog: ApprovalScanLogger = (entry) => {
  console.info(JSON.stringify(entry));
};
export function emitApprovalScanLog(logger: ApprovalScanLogger, entry: ApprovalScanLog): void {
  // Observability must never change a verdict or interrupt durable outbox work.
  try { logger(entry); } catch { /* No raw logger exception is safe to report. */ }
}
