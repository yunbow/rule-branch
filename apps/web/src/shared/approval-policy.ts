import { createHash } from "node:crypto";

export type ApprovalMode = "manual" | "shadow" | "auto";
export type ApprovalDocument = Record<string, unknown>;
export const APPROVAL_POLICY_VERSION = "google-approval-v1";
export const APPROVAL_RUBRIC_VERSION = "rule-maintenance-v1";
export interface ApprovalConfig {
  mode: ApprovalMode;
  workspaceIds: string[];
  project: string;
  location: string;
  model: string;
  armorTemplate: string;
  minJudgeScore: number;
  minGroundednessConfidence: number;
  maxPerScan: number;
  timeoutMs: number;
}
export interface ApprovalContext {
  workspace: ApprovalDocument;
  project: ApprovalDocument | null;
  rule: ApprovalDocument;
  proposal: ApprovalDocument;
  currentVersion: ApprovalDocument | null;
  relatedRules: Array<{ rule: ApprovalDocument; version: ApprovalDocument | null }>;
  evidence: ApprovalDocument[];
  findings: ApprovalDocument[];
  repositories: ApprovalDocument[];
  warnings: string[];
  issues: string[];
}
export interface ApprovalSignals {
  recommendation: "APPROVE" | "ESCALATE" | "REJECT";
  risk: "LOW" | "MEDIUM" | "HIGH";
  evidenceSupported: boolean;
  preservesIntent: boolean;
  conflictsWithRules: boolean;
  weakensProtection: boolean;
  judgeScore: number;
  groundednessScore: number;
  groundednessConfidence: number;
  armorPassed: boolean;
}
export interface ApprovalOutcome {
  state: "auto_approved" | "human_required";
  reasonCodes: string[];
  wouldAutoApprove: boolean;
  signals?: ApprovalSignals;
}
export function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as ApprovalDocument).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function textDigest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function isUnitScore(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function numberSetting(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error("INVALID_APPROVAL_CONFIGURATION");
  return number;
}
export function loadApprovalConfig(env: Record<string, string | undefined>): ApprovalConfig {
  const mode = env.RULEBRANCH_APPROVAL_MODE ?? "manual";
  if (!["manual", "shadow", "auto"].includes(mode)) throw new Error("INVALID_APPROVAL_MODE");
  const workspaceIds = [...new Set((env.RULEBRANCH_APPROVAL_WORKSPACE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (workspaceIds.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || workspaceIds.length > 20) throw new Error("INVALID_APPROVAL_WORKSPACES");
  return {
    mode: mode as ApprovalMode, workspaceIds,
    project: env.GOOGLE_CLOUD_PROJECT ?? "", location: env.RULEBRANCH_APPROVAL_LOCATION ?? "us-central1",
    model: env.RULEBRANCH_APPROVAL_MODEL ?? "", armorTemplate: env.RULEBRANCH_MODEL_ARMOR_TEMPLATE ?? "",
    minJudgeScore: numberSetting(env.RULEBRANCH_APPROVAL_MIN_JUDGE_SCORE, 0.95, 0.9, 1),
    minGroundednessConfidence: numberSetting(env.RULEBRANCH_APPROVAL_MIN_GROUNDEDNESS_CONFIDENCE, 0.95, 0.9, 1),
    maxPerScan: Math.floor(numberSetting(env.RULEBRANCH_APPROVAL_MAX_PER_SCAN, 2, 1, 3)),
    timeoutMs: numberSetting(env.RULEBRANCH_APPROVAL_TIMEOUT_MS, 15000, 1000, 20000),
  };
}
export function googleConfigurationValid(config: ApprovalConfig): boolean {
  return /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.project)
    && /^[a-z]+-[a-z]+[0-9]$/.test(config.location)
    && /^gemini-[A-Za-z0-9._-]+$/.test(config.model)
    && /^projects\/[A-Za-z0-9-]+\/locations\/[a-z0-9-]+\/templates\/[A-Za-z0-9_-]+$/.test(config.armorTemplate);
}
function withoutReview(value: ApprovalDocument): ApprovalDocument {
  const { approvalReview: _review, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}
/** Lifecycle review writes do not change the evaluated material; rule/evidence changes do. */
export function contextDigest(context: ApprovalContext): string {
  return digest({ ...context, proposal: withoutReview(context.proposal) });
}
export function approvalRiskReasons(context: ApprovalContext, config: ApprovalConfig): string[] {
  const { rule, proposal, currentVersion, workspace } = context;
  const reasons = [...context.issues];
  if (!config.workspaceIds.includes(String(workspace.id))) reasons.push("WORKSPACE_NOT_ENABLED");
  if ((workspace.settings as ApprovalDocument | undefined)?.aiDataUsageConsent !== true) reasons.push("AI_DATA_CONSENT_REQUIRED");
  if (workspace.deletedAt || workspace.status !== "active") reasons.push("WORKSPACE_INACTIVE");
  if (!context.project || context.project.deletedAt || context.project.status !== "active") reasons.push("PROJECT_INACTIVE");
  if (rule.scopeType !== "project" || rule.scopeId !== rule.projectId || rule.layer !== "L3"
    || !["default", "advisory"].includes(String(rule.enforcement))
    || !["guideline", "coding-style"].includes(String(rule.type))) reasons.push("PROTECTED_RULE");
  if (!["clarify", "refactor"].includes(String(proposal.changeType))) reasons.push("NON_MAINTENANCE_CHANGE");
  if (rule.evaluationMode !== "semantic") reasons.push("EXECUTABLE_CHECKS_REQUIRE_HUMAN");
  if (!["active", "stale"].includes(String(rule.status)) || !currentVersion || currentVersion.status !== "approved" || proposal.changeType === "initial") reasons.push("INITIAL_OR_INACTIVE_RULE");
  if (rule.deletedAt || proposal.deletedAt || proposal.status !== "proposed") reasons.push("PROPOSAL_INACTIVE");
  if (proposal.truncation || context.warnings.length) reasons.push("UNTRUSTED_OR_INCOMPLETE_INPUT");
  if (typeof proposal.content !== "string" || !proposal.content.trim() || typeof proposal.rationale !== "string" || !proposal.rationale.trim()) reasons.push("INVALID_PROPOSAL");
  if (proposal.ruleId !== rule.id || (currentVersion && currentVersion.ruleId !== rule.id)) reasons.push("RULE_VERSION_MISMATCH");
  const ids = proposal.evidenceIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || new Set(ids).size !== ids.length || context.evidence.length !== ids.length) reasons.push("EVIDENCE_MISSING");
  for (const item of context.evidence) {
    const ref = item.ref as ApprovalDocument | undefined;
    const repo = context.repositories.find((repository) => repository.id === item.repositoryId);
    if (item.ownerWorkspaceId !== workspace.id || item.deletedAt || item.excerptPurgedAt || item.excerptState !== "present"
      || typeof item.excerpt !== "string" || !item.excerpt.trim() || item.excerptHash !== textDigest(String(item.excerpt))
      || typeof ref?.commitSha !== "string" || !/^[0-9a-f]{40}$/.test(ref.commitSha)
      || !repo || repo.status !== "active" || repo.projectId !== rule.projectId) reasons.push("EVIDENCE_UNVERIFIABLE");
  }
  const findingIds = Array.isArray(proposal.driftFindingIds) ? proposal.driftFindingIds : [];
  const targets = context.findings.filter((finding) => findingIds.includes(finding.id));
  if (targets.length !== findingIds.length || targets.some((finding) => finding.ownerWorkspaceId !== workspace.id || finding.ruleId !== rule.id || finding.status !== "accepted" || finding.ruleVersionId !== currentVersion?.id)) reasons.push("FINDING_CHANGED");
  if (context.relatedRules.some((entry) => ["active", "stale"].includes(String(entry.rule.status)) && (!entry.version || entry.version.status !== "approved"))) reasons.push("RELATED_RULE_VERSION_MISSING");
  return [...new Set(reasons)];
}
export function decideApproval(context: ApprovalContext, config: ApprovalConfig, signals?: ApprovalSignals, failures: string[] = []): ApprovalOutcome {
  const reasons = [...approvalRiskReasons(context, config), ...failures];
  if (!signals) reasons.push("EVALUATION_UNAVAILABLE");
  else {
    if (!signals.armorPassed) reasons.push("MODEL_ARMOR_BLOCKED");
    if (signals.recommendation !== "APPROVE" || signals.risk !== "LOW" || signals.evidenceSupported !== true
      || signals.preservesIntent !== true || signals.conflictsWithRules !== false || signals.weakensProtection !== false) reasons.push("GEMINI_REQUIRES_HUMAN");
    if (!isUnitScore(signals.judgeScore) || signals.judgeScore < config.minJudgeScore) reasons.push("JUDGE_SCORE_LOW");
    if (signals.groundednessScore !== 1 || !isUnitScore(signals.groundednessConfidence) || signals.groundednessConfidence < config.minGroundednessConfidence) reasons.push("GROUNDING_INSUFFICIENT");
  }
  const wouldAutoApprove = reasons.length === 0;
  if (config.mode !== "auto") reasons.push(config.mode === "shadow" ? "SHADOW_MODE" : "MANUAL_MODE");
  return { state: reasons.length ? "human_required" : "auto_approved", reasonCodes: [...new Set(reasons)], wouldAutoApprove, ...(signals ? { signals } : {}) };
}
export function reviewPayload(context: ApprovalContext): string {
  const meta = (rule: ApprovalDocument) => ({ key: rule.key, layer: rule.layer, type: rule.type, enforcement: rule.enforcement, selector: rule.selector });
  return JSON.stringify({
    rule: meta(context.rule),
    currentRule: context.currentVersion?.content,
    proposedRule: context.proposal.content, rationale: context.proposal.rationale, compatibility: context.proposal.compatibility,
    evidence: context.evidence.map((item) => ({ id: item.id, ref: item.ref, excerpt: item.excerpt })),
    otherRules: context.relatedRules.filter((item) => ["active", "stale"].includes(String(item.rule.status)) && item.rule.id !== context.rule.id).map((item) => ({ ...meta(item.rule), content: item.version?.content })),
    findings: context.findings.map((item) => ({ summary: item.summary, detail: item.detail })),
  });
}
