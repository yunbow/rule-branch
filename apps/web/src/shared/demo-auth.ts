import { createHash, timingSafeEqual } from "node:crypto";
import { SESSION_MAX_AGE_MS, signSession } from "./auth.ts";
import type { DocumentData, FirestoreRuleStore } from "./rulestore.ts";
import { requireRequestedWith } from "./request-security.ts";
import { JUDGE_DEMO_USER_ID } from "./demo-session.ts";

export const JUDGE_DEMO = Object.freeze({
  userId: JUDGE_DEMO_USER_ID,
  workspaceId: "judge-demo-workspace",
  memberId: "judge-demo-member",
  installationId: "judge-demo-installation",
  projectId: "judge-demo-project",
  repositoryId: "judge-demo-repository",
  repositoryGithubId: "1415685835",
  repositoryFullName: "yunbow/rule-branch-demo-workspace-1",
  repositoryUrl: "https://github.com/yunbow/rule-branch-demo-workspace-1",
  baselinePrUrl: "https://github.com/yunbow/rule-branch-demo-workspace-1/pull/1",
  updatePrUrl: "https://github.com/yunbow/rule-branch-demo-workspace-1/pull/2",
});

type EnvLike = Record<string, string | undefined>;
type DemoDocument = readonly [collection: string, id: string, data: DocumentData];

const DEMO_LOGIN_BODY_LIMIT = 4 * 1024;

type RateLimitBucket = { attempts: number; resetAt: number };

export class JudgeDemoLoginRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private aggregate: RateLimitBucket = { attempts: 0, resetAt: 0 };
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly maxAggregateAttempts: number;
  private readonly now: () => number;

  constructor(
    maxAttempts = 5,
    windowMs = 60_000,
    maxEntries = 2_048,
    maxAggregateAttempts = 60,
    now = () => Date.now(),
  ) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.maxAggregateAttempts = maxAggregateAttempts;
    this.now = now;
  }

  get size(): number { return this.buckets.size; }

  take(request: Request): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    if (this.aggregate.resetAt <= now) {
      this.aggregate = { attempts: 0, resetAt: now + this.windowMs };
    }
    if (this.aggregate.attempts >= this.maxAggregateAttempts) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.aggregate.resetAt - now) / 1000)) };
    }
    this.aggregate.attempts += 1;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }

    const key = this.key(request);
    const current = this.buckets.get(key);
    if (current && current.resetAt > now) {
      if (current.attempts >= this.maxAttempts) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
      }
      current.attempts += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    while (this.buckets.size >= this.maxEntries) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(key, { attempts: 1, resetAt: now + this.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private key(request: Request): string {
    const forwarded = (request.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // Treat forwarded addresses only as a best-effort partitioning hint. The
    // independent aggregate cap remains effective when proxy topology is unclear.
    const address = forwarded.length >= 2 ? forwarded[forwarded.length - 2] : (forwarded[0] ?? "unknown");
    return digest(address).toString("base64url");
  }
}

const defaultJudgeDemoLoginRateLimiter = new JudgeDemoLoginRateLimiter();

const sessionCookie = (value: string) =>
  `rulebranch_session=${value}; HttpOnly; Path=/; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

async function readLimitedJsonObject(request: Request): Promise<
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "too_large" }
> {
  const rawLength = request.headers.get("content-length");
  if (rawLength && /^\d+$/.test(rawLength) && Number(rawLength) > DEMO_LOGIN_BODY_LIMIT) {
    return { kind: "too_large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DEMO_LOGIN_BODY_LIMIT) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
    return { kind: "ok", body: parsed as Record<string, unknown> };
  } catch {
    return { kind: "invalid" };
  }
}

export function isJudgeDemoLoginEnabled(env: EnvLike = process.env): boolean {
  return env.RULEBRANCH_DEMO_LOGIN_ENABLED === "1"
    && Boolean(env.RULEBRANCH_DEMO_LOGIN_ID)
    && Boolean(env.RULEBRANCH_DEMO_LOGIN_PASSWORD);
}

function demoDocuments(now: string): DemoDocument[] {
  const d = JUDGE_DEMO;
  const baselineRuleId = "judge-demo-rule-dependency";
  const reviewRuleId = "judge-demo-rule-zod-safety";
  const baselineV1 = "judge-demo-version-dependency-v1";
  const baselineV2 = "judge-demo-version-dependency-v2";
  const reviewV1 = "judge-demo-version-zod-v1";
  const reviewV2 = "judge-demo-version-zod-v2";
  const acceptedFindingId = "judge-demo-finding-zod-accepted";
  const openFindingId = "judge-demo-finding-react-open";
  const triggerId = "judge-demo-trigger-dependency-update";
  const mergedSnapshotId = "judge-demo-snapshot-merged";
  const draftSnapshotId = "judge-demo-snapshot-draft";
  const mergedPrId = "judge-demo-pr-merged";
  const draftPrId = "judge-demo-pr-draft";
  const mergedAt = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();

  return [
    ["users", d.userId, {
      id: d.userId,
      githubUserId: "judge-demo-no-github",
      login: "zenn-judge-demo",
      displayName: "Zenn審査デモ（閲覧専用）",
      email: null,
      locale: "ja",
      personalWorkspaceId: d.workspaceId,
      demoMode: true,
      createdAt: now,
      lastLoginAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["user_preferences", "judge-demo-preferences", {
      id: "judge-demo-preferences",
      userId: d.userId,
      explanationLevel: "normal",
      reviewDisplay: {},
      notifications: {},
      locale: "ja",
      transferPolicy: "prohibited",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["unique_keys", `user_preference:${d.userId}`, {
      id: `user_preference:${d.userId}`,
      kind: "user_preference",
      ownerWorkspaceId: null,
      targetTable: "user_preferences",
      targetId: "judge-demo-preferences",
      createdAt: now,
    }],
    ["workspaces", d.workspaceId, {
      id: d.workspaceId,
      kind: "organization",
      name: "RuleBranch 審査用デモ",
      slug: "rulebranch-judge-demo",
      ownerUserId: "rulebranch-demo-owner",
      githubOrgId: null,
      githubOrgLogin: null,
      status: "active",
      demoMode: true,
      settings: {
        defaultLocale: "ja",
        prCommentRetentionDays: 180,
        evidenceRetentionDays: 365,
        allowAiAutoProposal: true,
        aiDataUsageConsent: true,
        aiProcessingAcknowledgedAt: now,
      },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["workspace_members", d.memberId, {
      id: d.memberId,
      workspaceId: d.workspaceId,
      userId: d.userId,
      role: "viewer",
      joinedVia: "judge_demo",
      invitedByUserId: null,
      invitationId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["unique_keys", `workspace_member:${d.workspaceId}:${d.userId}`, {
      id: `workspace_member:${d.workspaceId}:${d.userId}`,
      kind: "workspace_member",
      ownerWorkspaceId: d.workspaceId,
      targetTable: "workspace_members",
      targetId: d.memberId,
      createdAt: now,
    }],
    ["installations", d.installationId, {
      id: d.installationId,
      ownerWorkspaceId: d.workspaceId,
      githubInstallationId: "judge-demo-readonly",
      status: "active",
      repositorySelection: "selected",
      accountType: "User",
      accountLogin: "yunbow",
      installedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      demoMode: true,
    }],
    ["projects", d.projectId, {
      id: d.projectId,
      ownerWorkspaceId: d.workspaceId,
      name: "RuleBranch Demo Workspace 1",
      slug: "rule-branch-demo-workspace-1",
      description: "React 18 / Zod 3 から React 19 / Zod 4 への更新を題材に、Drift検出からDraft PRまでを確認する審査用プロジェクトです。",
      status: "active",
      companionProfile: { name: "RuleBranch", tone: "helpful", verbosity: "balanced" },
      primaryLanguages: ["TypeScript"],
      frameworks: ["React", "Zod"],
      focusThemes: ["Dependency Drift", "Human-in-the-loop", "AI coding governance"],
      demoMode: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["repositories", d.repositoryId, {
      id: d.repositoryId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      installationId: d.installationId,
      githubRepoId: d.repositoryGithubId,
      fullName: d.repositoryFullName,
      githubOwnerLogin: "yunbow",
      defaultBranch: "main",
      status: "active",
      demoMode: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["analysis_jobs", "judge-demo-job-bootstrap", {
      id: "judge-demo-job-bootstrap",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      type: "bootstrap",
      payload: {},
      status: "done",
      attempts: 1,
      idempotencyKey: `bootstrap:${d.projectId}:judge-demo`,
      error: null,
      warnings: [],
      warningsOverflow: 0,
      createdAt: mergedAt,
      startedAt: mergedAt,
      finishedAt: mergedAt,
      deletedAt: null,
    }],
    ["analysis_jobs", "judge-demo-job-drift", {
      id: "judge-demo-job-drift",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      type: "drift_scan",
      payload: { triggerId },
      status: "done",
      attempts: 1,
      idempotencyKey: `drift_scan:${triggerId}:judge-demo`,
      error: null,
      warnings: [],
      warningsOverflow: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      deletedAt: null,
    }],
    ["analysis_jobs", "judge-demo-job-proposal", {
      id: "judge-demo-job-proposal",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      type: "proposal",
      payload: { driftFindingId: acceptedFindingId },
      status: "done",
      attempts: 1,
      idempotencyKey: `proposal:${acceptedFindingId}:judge-demo`,
      error: null,
      warnings: [],
      warningsOverflow: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      deletedAt: null,
    }],
    ["analysis_jobs", "judge-demo-job-compile", {
      id: "judge-demo-job-compile",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      type: "compile",
      payload: { repositoryId: d.repositoryId, ruleVersionId: baselineV2 },
      status: "done",
      attempts: 1,
      idempotencyKey: `compile:${d.repositoryId}:${baselineV2}:judge-demo`,
      error: null,
      warnings: [],
      warningsOverflow: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      deletedAt: null,
    }],
    ["rules", baselineRuleId, {
      id: baselineRuleId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      scopeType: "project",
      scopeId: d.projectId,
      selector: { repositoryIds: [d.repositoryId], languages: ["TypeScript"], frameworks: ["React"], dependencies: ["react", "zod"] },
      title: "依存関係の互換性を確認する",
      key: "dependency-compatibility",
      layer: "L3",
      type: "guideline",
      evaluationMode: "semantic",
      enforcement: "advisory",
      status: "active",
      currentVersionId: baselineV2,
      nextVersion: 3,
      provenance: { sourceType: "human" },
      createdAt: mergedAt,
      updatedAt: now,
      deletedAt: null,
    }],
    ["rule_versions", baselineV1, {
      id: baselineV1,
      ownerWorkspaceId: d.workspaceId,
      ruleId: baselineRuleId,
      version: 1,
      status: "superseded",
      content: "# Dependency compatibility\n\nReact 18 と Zod 3 を承認済みの互換性ベースラインとします。",
      rationale: "初回解析でリポジトリの依存関係と実装を確認したため",
      evidenceIds: ["judge-demo-evidence-baseline"],
      compatibility: { frameworks: { react: "^18" }, tools: { zod: "^3" } },
      changeType: "initial",
      provenance: { sourceType: "ai" },
      createdAt: mergedAt,
      updatedAt: now,
      deletedAt: null,
    }],
    ["rule_versions", baselineV2, {
      id: baselineV2,
      ownerWorkspaceId: d.workspaceId,
      ruleId: baselineRuleId,
      version: 2,
      status: "approved",
      content: "# Dependency compatibility\n\nReact 19 と Zod 4 を新しい互換性ベースラインとし、メジャー更新時はEvidenceと移行影響を確認します。",
      rationale: "package.json で React 18→19 / Zod 3→4 の更新を検出し、互換性ルールを更新したため",
      evidenceIds: ["judge-demo-evidence-package", "judge-demo-evidence-profile"],
      compatibility: { frameworks: { react: "^19" }, tools: { zod: "^4" } },
      changeType: "clarify",
      provenance: { sourceType: "ai" },
      approvedBy: { kind: "user", id: "rulebranch-demo-maintainer", displayName: "Demo Maintainer" },
      approvedAt: now,
      compilePending: false,
      pendingCompileRepositoryIds: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["rules", reviewRuleId, {
      id: reviewRuleId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      scopeType: "project",
      scopeId: d.projectId,
      selector: { repositoryIds: [d.repositoryId], languages: ["TypeScript"], dependencies: ["zod"] },
      title: "Zodの入力検証パターンを安全に移行する",
      key: "zod-validation-safety",
      layer: "L3",
      type: "guideline",
      evaluationMode: "semantic",
      enforcement: "advisory",
      status: "stale",
      currentVersionId: reviewV1,
      nextVersion: 3,
      staleSince: now,
      provenance: { sourceType: "human" },
      createdAt: mergedAt,
      updatedAt: now,
      deletedAt: null,
    }],
    ["rule_versions", reviewV1, {
      id: reviewV1,
      ownerWorkspaceId: d.workspaceId,
      ruleId: reviewRuleId,
      version: 1,
      status: "approved",
      content: "# Zod validation safety\n\nZod 3 の既存スキーマを基準に入力検証を実装します。",
      rationale: "既存の profileSchema を基準にしたため",
      evidenceIds: ["judge-demo-evidence-baseline"],
      compatibility: { tools: { zod: "^3" } },
      changeType: "initial",
      provenance: { sourceType: "human" },
      approvedBy: { kind: "user", id: "rulebranch-demo-maintainer" },
      approvedAt: mergedAt,
      createdAt: mergedAt,
      updatedAt: mergedAt,
      deletedAt: null,
    }],
    ["rule_versions", reviewV2, {
      id: reviewV2,
      ownerWorkspaceId: d.workspaceId,
      ruleId: reviewRuleId,
      version: 2,
      status: "proposed",
      content: "# Zod validation safety\n\nZod 4 への移行では、既存の profileSchema とエラー処理の互換性を確認し、差異をテストで固定します。",
      rationale: "Zod 4 へのメジャー更新により、既存の検証ルールが古くなった可能性があるため",
      aiSummary: "package.json と src/profile.ts を根拠に、Zod 4 移行時の検証ルール更新を提案します。",
      evidenceIds: ["judge-demo-evidence-package", "judge-demo-evidence-profile"],
      driftFindingIds: [acceptedFindingId],
      changeType: "clarify",
      provenance: { sourceType: "ai" },
      approvalReview: {
        state: "human_required",
        mode: "enforce",
        checkedAt: now,
        wouldAutoApprove: false,
        reasonCodes: ["JUDGE_SCORE_LOW", "GROUNDING_INSUFFICIENT"],
        signals: {
          judgeScore: 0.88,
          groundednessScore: 0.91,
          groundednessConfidence: 0.89,
        },
        modelArmor: { input: "pass", output: "pass" },
      },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["change_triggers", triggerId, {
      id: triggerId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      type: "dependency_update",
      source: {
        repositoryId: d.repositoryId,
        commitSha: "00338b3219d5d40bf3812085610cbf57d6349c60",
        before: "2dad0ce54d4e134d943d0fb8bc4f487ca884e4ed",
        paths: ["package.json"],
      },
      detectedBy: "github",
      resultingFindingIds: [acceptedFindingId, openFindingId],
      processedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["drift_findings", acceptedFindingId, {
      id: acceptedFindingId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      scopeId: d.projectId,
      ruleId: reviewRuleId,
      triggerId,
      status: "accepted",
      driftType: "dependency_drift",
      severity: "high",
      confidence: 0.96,
      summary: "Zod 3→4 により入力検証ルールの見直しが必要",
      detail: "package.json で Zod のメジャー更新を検出しました。src/profile.ts の検証パターンと既存ルールの互換性を確認します。",
      evidenceIds: ["judge-demo-evidence-package", "judge-demo-evidence-profile"],
      proposalVersionId: reviewV2,
      proposalVersionStatus: "proposed",
      provenance: { sourceType: "ai" },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["drift_findings", openFindingId, {
      id: openFindingId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      scopeId: d.projectId,
      ruleId: reviewRuleId,
      triggerId,
      status: "open",
      driftType: "compatibility_drift",
      severity: "medium",
      confidence: 0.86,
      summary: "React 19 更新後の実装ガイドを追加確認",
      detail: "React 19 への更新を受け、コンポーネント実装の既存ガイドが新しい依存関係と一致しているか確認が必要です。",
      evidenceIds: ["judge-demo-evidence-package"],
      proposalVersionId: null,
      provenance: { sourceType: "ai" },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["evidence", "judge-demo-evidence-baseline", {
      id: "judge-demo-evidence-baseline",
      ownerWorkspaceId: d.workspaceId,
      repositoryId: d.repositoryId,
      label: "PR #1 / baseline rules",
      kind: "commit",
      ref: { url: d.baselinePrUrl },
      commitSha: "2dad0ce54d4e134d943d0fb8bc4f487ca884e4ed",
      excerptState: "present",
      excerpt: "React 18 / Zod 3 を承認済みの互換性ベースラインとして生成。",
      createdAt: mergedAt,
      deletedAt: null,
    }],
    ["evidence", "judge-demo-evidence-package", {
      id: "judge-demo-evidence-package",
      ownerWorkspaceId: d.workspaceId,
      repositoryId: d.repositoryId,
      driftFindingId: acceptedFindingId,
      ruleVersionId: reviewV2,
      label: "package.json",
      kind: "file_excerpt",
      ref: { path: "package.json", lineStart: 6, lineEnd: 9 },
      commitSha: "00338b3219d5d40bf3812085610cbf57d6349c60",
      excerptState: "present",
      excerpt: "\"react\": \"^19.1.1\" / \"zod\": \"^4.1.0\"",
      createdAt: now,
      deletedAt: null,
    }],
    ["evidence", "judge-demo-evidence-profile", {
      id: "judge-demo-evidence-profile",
      ownerWorkspaceId: d.workspaceId,
      repositoryId: d.repositoryId,
      driftFindingId: acceptedFindingId,
      ruleVersionId: reviewV2,
      label: "src/profile.ts",
      kind: "file_excerpt",
      ref: { path: "src/profile.ts", lineStart: 1, lineEnd: 13 },
      commitSha: "00338b3219d5d40bf3812085610cbf57d6349c60",
      excerptState: "present",
      excerpt: "profileSchema.parse(input) を使う既存入力検証。",
      createdAt: now,
      deletedAt: null,
    }],
    ["resolution_snapshots", mergedSnapshotId, {
      id: mergedSnapshotId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      ruleVersionIds: [baselineV1, reviewV1],
      conflicts: [],
      resolverVersion: "judge-demo",
      resolvedAt: mergedAt,
      createdAt: mergedAt,
      updatedAt: mergedAt,
      deletedAt: null,
    }],
    ["resolution_snapshots", draftSnapshotId, {
      id: draftSnapshotId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      ruleVersionIds: [baselineV2],
      conflicts: [],
      resolverVersion: "judge-demo",
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["revision_prs", mergedPrId, {
      id: mergedPrId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: mergedSnapshotId,
      prNumber: 1,
      prUrl: d.baselinePrUrl,
      branch: "rulebranch/baseline-rules",
      kind: "compile",
      status: "merged",
      isDraft: false,
      openedAt: mergedAt,
      mergedAt,
      mergeCommitSha: "2dad0ce54d4e134d943d0fb8bc4f487ca884e4ed",
      verification: {
        state: "verified",
        checkedCommitSha: "2dad0ce54d4e134d943d0fb8bc4f487ca884e4ed",
        mismatchedPaths: [],
      },
      createdAt: mergedAt,
      updatedAt: mergedAt,
      deletedAt: null,
    }],
    ["revision_prs", draftPrId, {
      id: draftPrId,
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: draftSnapshotId,
      prNumber: 2,
      prUrl: d.updatePrUrl,
      branch: "rulebranch/react19-rule-update",
      kind: "compile",
      status: "draft_open",
      isDraft: true,
      openedAt: now,
      mergedAt: null,
      verification: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["compiled_artifacts", "judge-demo-artifact-merged-agents", {
      id: "judge-demo-artifact-merged-agents",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: mergedSnapshotId,
      revisionPrId: mergedPrId,
      target: "agents-md",
      path: "AGENTS.md",
      gitBlobSha: "baseline-demo",
      commitSha: "2dad0ce54d4e134d943d0fb8bc4f487ca884e4ed",
      publishedAt: mergedAt,
      contentOmitted: false,
      createdAt: mergedAt,
      updatedAt: mergedAt,
      deletedAt: null,
    }],
    ["compiled_artifacts", "judge-demo-artifact-draft-agents", {
      id: "judge-demo-artifact-draft-agents",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: draftSnapshotId,
      revisionPrId: draftPrId,
      target: "agents-md",
      path: "AGENTS.md",
      gitBlobSha: "draft-demo-agents",
      commitSha: "078573f2d90cfc7544b33697ad56291a3ecb900f",
      publishedAt: null,
      contentOmitted: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["compiled_artifacts", "judge-demo-artifact-draft-claude", {
      id: "judge-demo-artifact-draft-claude",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: draftSnapshotId,
      revisionPrId: draftPrId,
      target: "claude-md",
      path: "CLAUDE.md",
      gitBlobSha: "draft-demo-claude",
      commitSha: "078573f2d90cfc7544b33697ad56291a3ecb900f",
      publishedAt: null,
      contentOmitted: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["compiled_artifacts", "judge-demo-artifact-draft-copilot", {
      id: "judge-demo-artifact-draft-copilot",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: draftSnapshotId,
      revisionPrId: draftPrId,
      target: "copilot-instructions",
      path: ".github/copilot-instructions.md",
      gitBlobSha: "draft-demo-copilot",
      commitSha: "078573f2d90cfc7544b33697ad56291a3ecb900f",
      publishedAt: null,
      contentOmitted: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["compiled_artifacts", "judge-demo-artifact-draft-rule", {
      id: "judge-demo-artifact-draft-rule",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      repositoryId: d.repositoryId,
      resolutionSnapshotId: draftSnapshotId,
      revisionPrId: draftPrId,
      target: "rulebranch-rules",
      path: ".rulebranch/rules/L3/dependency-compatibility.md",
      gitBlobSha: "draft-demo-rule",
      commitSha: "078573f2d90cfc7544b33697ad56291a3ecb900f",
      publishedAt: null,
      contentOmitted: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
    ["decision_memories", "judge-demo-decision-dependency-v2", {
      id: "judge-demo-decision-dependency-v2",
      ownerWorkspaceId: d.workspaceId,
      projectId: d.projectId,
      title: "React 19 / Zod 4 を新しい互換性ベースラインとして承認",
      summary: "依存更新のEvidenceを確認し、AI提案を人間の判断として確定。生成物はDraft PR #2で確認中。",
      decision: "approve",
      linkedRuleIds: [baselineRuleId],
      linkedRuleVersionIds: [baselineV2],
      rationale: "メジャー更新に伴う移行影響をルールへ反映するため",
      actor: { kind: "user", id: "rulebranch-demo-maintainer" },
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }],
  ];
}

export async function ensureJudgeDemoWorkspace(store: FirestoreRuleStore): Promise<void> {
  const documents = demoDocuments(new Date().toISOString());
  await store.runTransaction(async (tx) => {
    const refs = documents.map(([collection, id]) => store.documentRef(collection, id));
    const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
    documents.forEach(([, , data], index) => {
      if (snapshots[index].exists) tx.update(refs[index], data);
      else tx.create(refs[index], data);
    });
  });
}

export function createJudgeDemoLoginHandlers(
  store: FirestoreRuleStore,
  sessionSecret: string,
  env: EnvLike = process.env,
  rateLimiter: JudgeDemoLoginRateLimiter = defaultJudgeDemoLoginRateLimiter,
) {
  return {
    login: async (request: Request): Promise<Response> => {
      if (!isJudgeDemoLoginEnabled(env)) return new Response(null, { status: 404 });
      const blocked = requireRequestedWith(request);
      if (blocked) return blocked;

      const rateLimit = rateLimiter.take(request);
      if (!rateLimit.allowed) {
        return Response.json({ error: "DEMO_LOGIN_RATE_LIMITED" }, {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        });
      }

      const parsed = await readLimitedJsonObject(request);
      if (parsed.kind === "too_large") {
        return Response.json({ error: "INVALID_DEMO_LOGIN_REQUEST" }, {
          status: 413,
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (parsed.kind === "invalid") {
        return Response.json({ error: "INVALID_DEMO_LOGIN_REQUEST" }, {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const body = parsed.body;

      const id = typeof body.id === "string" ? body.id : "";
      const password = typeof body.password === "string" ? body.password : "";
      const expectedId = env.RULEBRANCH_DEMO_LOGIN_ID ?? "";
      const expectedPassword = env.RULEBRANCH_DEMO_LOGIN_PASSWORD ?? "";
      const validShape = id.length > 0 && id.length <= 128 && password.length > 0 && password.length <= 256;
      if (!validShape || !safeEqual(id, expectedId) || !safeEqual(password, expectedPassword)) {
        return Response.json({ error: "INVALID_DEMO_CREDENTIALS" }, {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        });
      }

      await ensureJudgeDemoWorkspace(store);
      const redirectTo = `/w/${JUDGE_DEMO.workspaceId}`;
      const response = Response.json({
        userId: JUDGE_DEMO.userId,
        workspaceId: JUDGE_DEMO.workspaceId,
        projectId: JUDGE_DEMO.projectId,
        redirectTo,
        readOnly: true,
      }, { headers: { "Cache-Control": "no-store" } });
      response.headers.set(
        "Set-Cookie",
        sessionCookie(signSession({ userId: JUDGE_DEMO.userId, issuedAt: Date.now() }, sessionSecret)),
      );
      return response;
    },
  };
}
