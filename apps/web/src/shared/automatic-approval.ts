import { randomUUID } from "node:crypto";
import { APPROVAL_POLICY_VERSION, approvalRiskReasons, contextDigest, decideApproval, type ApprovalConfig, type ApprovalContext, type ApprovalOutcome, type ApprovalSignals } from "./approval-policy.ts";
import { ApprovalEvaluationError, type ApprovalEvaluator } from "./google-approval-review.ts";
import { emitApprovalScanLog, safeEvaluationFailureCode, writeApprovalScanLog, type ApprovalScanDiagnostics, type ApprovalScanLogger } from "./approval-observability.ts";

export type ApprovalPointer = { workspaceId: string; versionId: string };
export interface ApprovalRepository {
  listPending(workspaceId: string, maximum: number): Promise<string[]>;
  claim(pointer: ApprovalPointer, evaluationId: string, config: ApprovalConfig): Promise<boolean>;
  load(pointer: ApprovalPointer): Promise<ApprovalContext>;
  complete(pointer: ApprovalPointer, evaluationId: string, expectedDigest: string | null, outcome: ApprovalOutcome, config: ApprovalConfig): Promise<"auto_approved" | "human_required" | "skipped">;
  flushCompilations(workspaceId: string, onDispatchFailure?: () => void): Promise<number>;
}
export type ApprovalScanResult = { policyVersion: string; mode: string; reviewed: number; autoApproved: number; humanRequired: number; skipped: number; failed: number; compilationDispatches: number };
/** Scheduler-driven: handles both Worker-generated and manually authored proposals.
 * A model never receives a write-capable tool. Only this bounded policy path can commit.
 */
export class AutomaticApprovalService {
  readonly config: ApprovalConfig;
  private readonly repository: ApprovalRepository;
  private readonly evaluator: ApprovalEvaluator;
  private readonly logger: ApprovalScanLogger;
  constructor(repository: ApprovalRepository, evaluator: ApprovalEvaluator, config: ApprovalConfig, logger: ApprovalScanLogger = writeApprovalScanLog) { this.repository = repository; this.evaluator = evaluator; this.config = config; this.logger = logger; }
  async scan(): Promise<ApprovalScanResult> {
    const result: ApprovalScanResult = { policyVersion: APPROVAL_POLICY_VERSION, mode: this.config.mode, reviewed: 0, autoApproved: 0, humanRequired: 0, skipped: 0, failed: 0, compilationDispatches: 0 };
    const diagnostics: ApprovalScanDiagnostics = { evaluationFailures: 0, evaluationApiFailures: 0, compilationFailures: 0, evaluationFailureReasons: {} };
    const scanId = randomUUID(), startedAt = Date.now();
    let completed = false;
    emitApprovalScanLog(this.logger, { severity: "INFO", event: "approval_scan_started", scanId, mode: result.mode, policyVersion: result.policyVersion });
    const flush = async (workspaceId: string): Promise<void> => {
      try {
        result.compilationDispatches += await this.repository.flushCompilations(workspaceId, () => { diagnostics.compilationFailures += 1; });
      } catch { result.failed += 1; diagnostics.compilationFailures += 1; }
    };
    try {
      if (this.config.mode === "manual") { completed = true; return result; }
      const deadline = startedAt + 240000;
      for (const workspaceId of this.config.workspaceIds) {
        await flush(workspaceId);
        if (result.reviewed >= this.config.maxPerScan || Date.now() >= deadline) continue;
        let candidates: string[];
        try { candidates = await this.repository.listPending(workspaceId, this.config.maxPerScan - result.reviewed); }
        catch { result.failed += 1; continue; }
        for (const versionId of candidates) {
          if (Date.now() >= deadline || result.reviewed >= this.config.maxPerScan) break;
          const pointer = { workspaceId, versionId }, evaluationId = randomUUID();
          try {
            if (!await this.repository.claim(pointer, evaluationId, this.config)) { result.skipped += 1; continue; }
            result.reviewed += 1;
            let fingerprint: string | null = null, outcome: ApprovalOutcome;
            try {
              const context = await this.repository.load(pointer); fingerprint = contextDigest(context);
              const riskReasons = approvalRiskReasons(context, this.config);
              // Do not send protected, unconsented, incomplete or unverifiable inputs to Google.
              if (riskReasons.length) outcome = { state: "human_required", reasonCodes: riskReasons, wouldAutoApprove: false };
              else {
                let signals: ApprovalSignals | undefined; const failures: string[] = [];
                try { signals = await this.evaluator.evaluate(context); }
                catch (error) {
                  const code = safeEvaluationFailureCode(error instanceof ApprovalEvaluationError ? error.code : undefined);
                  failures.push(code);
                  diagnostics.evaluationFailures += 1;
                  if (code === "GOOGLE_API_ERROR" || code === "GOOGLE_API_UNAVAILABLE") diagnostics.evaluationApiFailures += 1;
                  diagnostics.evaluationFailureReasons[code] = (diagnostics.evaluationFailureReasons[code] ?? 0) + 1;
                }
                outcome = decideApproval(context, this.config, signals, failures);
              }
            } catch { outcome = { state: "human_required", reasonCodes: ["CONTEXT_UNAVAILABLE"], wouldAutoApprove: false }; }
            const state = await this.repository.complete(pointer, evaluationId, fingerprint, outcome, this.config);
            if (state === "auto_approved") result.autoApproved += 1;
            else if (state === "human_required") result.humanRequired += 1;
            else result.skipped += 1;
          } catch {
            // A persisted evaluating lease is recoverable. Its expiry is escalated rather
            // than reusing an uncertain result; no API error is interpreted as approval.
            result.failed += 1;
          }
        }
        await flush(workspaceId);
      }
      completed = true;
      return result;
    } finally {
      // Aggregate application-owned metadata only, never rule text, evidence,
      // request headers, tenant identifiers, provider bodies or exception stacks.
      emitApprovalScanLog(this.logger, {
        severity: !completed ? "ERROR" : result.failed || diagnostics.evaluationFailures || diagnostics.compilationFailures ? "WARNING" : "INFO",
        event: completed ? "approval_scan_completed" : "approval_scan_failed",
        scanId, durationMs: Math.max(0, Date.now() - startedAt), ...result, ...diagnostics,
        ...(!completed ? { errorCode: "APPROVAL_SCAN_FAILED" as const } : {}),
      });
    }
  }
}
