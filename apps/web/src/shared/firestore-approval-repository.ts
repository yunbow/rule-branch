import type { DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { FirestoreRuleStore } from "./rulestore.ts";
import { generateUlid } from "./ulid.ts";
import { APPROVAL_POLICY_VERSION, APPROVAL_RUBRIC_VERSION, contextDigest, decideApproval, type ApprovalConfig, type ApprovalContext, type ApprovalDocument, type ApprovalOutcome } from "./approval-policy.ts";
import type { ApprovalPointer, ApprovalRepository } from "./automatic-approval.ts";

const LEASE_MS = 5 * 60 * 1000;
const MINIMUM_AGE_MS = 2 * 60 * 1000;
const MAX_RULES = 200, MAX_FINDINGS = 100, MAX_REPOSITORIES = 20;
const idValid = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const data = (snapshot: DocumentSnapshot): ApprovalDocument | null => snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
const sorted = (items: ApprovalDocument[]) => items.sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
const reviewOf = (version: ApprovalDocument): ApprovalDocument => (version.approvalReview ?? {}) as ApprovalDocument;
const actor = { kind: "system" as const, id: APPROVAL_POLICY_VERSION };
const projectIdOf = (rule: ApprovalDocument): string | null => idValid(rule.projectId) ? rule.projectId : rule.scopeType === "project" && idValid(rule.scopeId) ? rule.scopeId : null;

/** Scoped Firestore adapter. Query reads are repeated inside the commit transaction,
 * including the entire applicable rule set, so concurrent changes and new conflicting
 * rules invalidate the evaluated snapshot. External AI calls are never in transactions.
 */
export class FirestoreApprovalRepository implements ApprovalRepository {
  private readonly db: Firestore;
  private readonly store: FirestoreRuleStore;
  constructor(db: Firestore, store: FirestoreRuleStore) { this.db = db; this.store = store; }
  private ref(collection: string, id: unknown) {
    if (!idValid(id)) throw new Error("INVALID_APPROVAL_REFERENCE");
    return this.db.collection(collection).doc(id);
  }
  private async audit(tx: Transaction, pointer: ApprovalPointer, action: string, evaluationId: string, after: ApprovalDocument) {
    await this.store.appendAuditLog({ workspaceId: pointer.workspaceId, actorUserId: null, actorKind: "system" }, {
      actor, action, targetType: "rule_versions", targetId: pointer.versionId, requestId: `approval:${evaluationId}`, after,
    }, tx as unknown as Parameters<FirestoreRuleStore["appendAuditLog"]>[2]);
  }
  async listPending(workspaceId: string, maximum: number): Promise<string[]> {
    const workspaceRef = this.ref("workspaces", workspaceId), workspace = data(await workspaceRef.get());
    if (!workspace || workspace.deletedAt) return [];
    let cursor = idValid(workspace.approvalScanCursor) ? workspace.approvalScanCursor : null;
    const ids: string[] = [];
    // A durable cursor prevents already-escalated proposals from starving new ones.
    for (let page = 0; page < 5 && ids.length < maximum; page += 1) {
      let query = this.db.collection("rule_versions").where("ownerWorkspaceId", "==", workspaceId).where("status", "==", "proposed").orderBy("__name__").limit(100);
      if (cursor) query = query.startAfter(cursor);
      const snapshots = await query.get();
      if (snapshots.empty) { cursor = null; break; }
      let visited = 0; const eligible: ApprovalDocument[] = [];
      for (const snapshot of snapshots.docs) {
        const version = data(snapshot)!;
        const review = reviewOf(version), age = Date.now() - Date.parse(String(version.createdAt));
        const terminal = ["human_required", "auto_approved"].includes(String(review.state));
        const leased = review.state === "evaluating" && Date.parse(String(review.leaseExpiresAt)) > Date.now();
        if (!version.deletedAt && !terminal && !leased && (!Number.isFinite(age) || age >= MINIMUM_AGE_MS)) eligible.push(version);
      }
      const ruleIds = [...new Set(eligible.map((version) => version.ruleId).filter(idValid))];
      const rules = ruleIds.length ? (await this.db.getAll(...ruleIds.map((id) => this.ref("rules", id)))).map(data).filter((item): item is ApprovalDocument => item !== null) : [];
      const rulesById = new Map(rules.map((rule) => [String(rule.id), rule]));
      const projectIds = [...new Set(rules.map(projectIdOf).filter((id): id is string => id !== null))];
      const projects = projectIds.length ? (await this.db.getAll(...projectIds.map((id) => this.ref("projects", id)))).map(data).filter((item): item is ApprovalDocument => item !== null) : [];
      const projectsById = new Map(projects.map((project) => [String(project.id), project]));
      const eligibleById = new Map(eligible.map((version) => [String(version.id), version]));
      for (const snapshot of snapshots.docs) {
        cursor = snapshot.id; visited += 1; const version = eligibleById.get(snapshot.id); if (!version) continue;
        const rule = rulesById.get(String(version.ruleId)), projectId = rule ? projectIdOf(rule) : null, project = projectId ? projectsById.get(projectId) : null;
        if (!rule || rule.ownerWorkspaceId !== workspaceId || rule.deletedAt || (projectId && (!project || project.ownerWorkspaceId !== workspaceId || project.deletedAt || project.status !== "active"))) continue;
        ids.push(String(version.id)); if (ids.length >= maximum) break;
      }
      if (visited === snapshots.docs.length && snapshots.docs.length < 100) { cursor = null; break; }
    }
    await workspaceRef.update({ approvalScanCursor: cursor });
    return ids;
  }
  async claim(pointer: ApprovalPointer, evaluationId: string, config: ApprovalConfig): Promise<boolean> {
    if (config.mode === "manual" || !config.workspaceIds.includes(pointer.workspaceId)) return false;
    return this.db.runTransaction(async (tx) => {
      const ref = this.ref("rule_versions", pointer.versionId), version = data(await tx.get(ref));
      if (!version || version.ownerWorkspaceId !== pointer.workspaceId || version.status !== "proposed" || version.deletedAt) return false;
      const rule = idValid(version.ruleId) ? data(await tx.get(this.ref("rules", version.ruleId))) : null;
      const projectId = rule ? projectIdOf(rule) : null;
      const project = rule && rule.ownerWorkspaceId === pointer.workspaceId && !rule.deletedAt && projectId ? data(await tx.get(this.ref("projects", projectId))) : null;
      if (!rule || rule.ownerWorkspaceId !== pointer.workspaceId || rule.deletedAt || (projectId && (!project || project.ownerWorkspaceId !== pointer.workspaceId || project.deletedAt || project.status !== "active"))) return false;
      const review = reviewOf(version), now = new Date().toISOString();
      if (["human_required", "auto_approved"].includes(String(review.state))) return false;
      if (review.state === "evaluating") {
        if (Date.parse(String(review.leaseExpiresAt)) > Date.now()) return false;
        // A crash/timeout must not leave a proposal permanently waiting for AI.
        const interrupted = { ...review, state: "human_required", checkedAt: now, reasonCodes: ["REVIEW_INTERRUPTED"], wouldAutoApprove: false };
        tx.update(ref, { approvalReview: interrupted, updatedAt: now });
        await this.audit(tx, pointer, "rule_version.escalate", evaluationId, interrupted);
        return false;
      }
      tx.update(ref, { approvalReview: { state: "evaluating", evaluationId, policyVersion: APPROVAL_POLICY_VERSION, mode: config.mode, startedAt: now, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() }, updatedAt: now });
      return true;
    });
  }
  private async loadWithin(tx: Transaction, pointer: ApprovalPointer): Promise<ApprovalContext> {
    const proposal = data(await tx.get(this.ref("rule_versions", pointer.versionId)));
    if (!proposal || proposal.ownerWorkspaceId !== pointer.workspaceId) throw new Error("APPROVAL_NOT_FOUND");
    const rule = data(await tx.get(this.ref("rules", proposal.ruleId)));
    if (!rule || rule.ownerWorkspaceId !== pointer.workspaceId) throw new Error("APPROVAL_NOT_FOUND");
    const projectId = projectIdOf(rule);
    const [workspaceSnapshot, projectSnapshot, rulesSnapshot, repositoriesSnapshot, findingsSnapshot, auditSnapshot] = await Promise.all([
      tx.get(this.ref("workspaces", pointer.workspaceId)),
      projectId ? tx.get(this.ref("projects", projectId)) : Promise.resolve(null),
      tx.get(this.db.collection("rules").where("ownerWorkspaceId", "==", pointer.workspaceId).limit(MAX_RULES + 1)),
      tx.get(this.db.collection("repositories").where("ownerWorkspaceId", "==", pointer.workspaceId).where("projectId", "==", projectId ?? "").limit(MAX_REPOSITORIES + 1)),
      tx.get(this.db.collection("drift_findings").where("ownerWorkspaceId", "==", pointer.workspaceId).where("ruleId", "==", rule.id).limit(MAX_FINDINGS + 1)),
      tx.get(this.db.collection("audit_logs").where("ownerWorkspaceId", "==", pointer.workspaceId).where("targetType", "==", "rule_versions").where("targetId", "==", proposal.id).limit(20)),
    ]);
    const rawWorkspace = data(workspaceSnapshot);
    if (!rawWorkspace) throw new Error("APPROVAL_NOT_FOUND");
    // The scanner's cursor is operational, not part of the evaluated policy context.
    const { approvalScanCursor: _cursor, ...workspace } = rawWorkspace;
    const project = projectSnapshot ? data(projectSnapshot) : null;
    if (projectId && (!project || project.ownerWorkspaceId !== pointer.workspaceId || project.deletedAt || project.status !== "active")) throw new Error("APPROVAL_NOT_FOUND");
    const issues: string[] = [];
    if (rulesSnapshot.size > MAX_RULES || repositoriesSnapshot.size > MAX_REPOSITORIES || findingsSnapshot.size > MAX_FINDINGS) issues.push("CONTEXT_LIMIT_EXCEEDED");
    const related = sorted(rulesSnapshot.docs.map((snapshot) => data(snapshot)!).filter((item) => (item.scopeType === "organization" && item.scopeId === pointer.workspaceId) || (item.scopeType === "project" && projectIdOf(item) === projectId)));
    const versionIds = [...new Set([rule.currentVersionId, ...related.map((item) => item.currentVersionId)].filter(idValid))];
    const evidenceIds = Array.isArray(proposal.evidenceIds) ? proposal.evidenceIds.filter(idValid).slice(0, 20) : [];
    const [versions, evidenceSnapshots] = await Promise.all([
      Promise.all(versionIds.map((id) => tx.get(this.ref("rule_versions", id)))),
      Promise.all(evidenceIds.map((id) => tx.get(this.ref("evidence", id)))),
    ]);
    const versionMap = new Map(versions.map((snapshot) => [snapshot.id, data(snapshot)]));
    for (const version of versionMap.values()) if (version && version.ownerWorkspaceId !== pointer.workspaceId) throw new Error("APPROVAL_NOT_FOUND");
    const warnings: string[] = [];
    if ((proposal.provenance as ApprovalDocument | undefined)?.sourceType === "ai") {
      const creation = auditSnapshot.docs.map((snapshot) => data(snapshot)!).find((entry) => ["rule_version.propose", "rule_version.create"].includes(String(entry.action)));
      if (!creation || !idValid(creation.requestId)) warnings.push("SOURCE_JOB_UNKNOWN");
      else {
        const sourceJob = data(await tx.get(this.ref("analysis_jobs", creation.requestId)));
        if (!sourceJob || sourceJob.ownerWorkspaceId !== pointer.workspaceId || sourceJob.projectId !== projectId || sourceJob.status !== "done") warnings.push("SOURCE_JOB_INCOMPLETE");
        if (Array.isArray(sourceJob?.warnings)) for (const warning of sourceJob.warnings) {
          const code = String((warning as ApprovalDocument).code);
          if (["possible_prompt_injection", "input_truncated", "output_truncated", "evidence_unverifiable"].includes(code)) warnings.push(code);
        }
      }
    }
    return {
      workspace, project, rule, proposal,
      currentVersion: versionMap.get(String(rule.currentVersionId)) ?? null,
      relatedRules: related.map((item) => ({ rule: item, version: versionMap.get(String(item.currentVersionId)) ?? null })),
      evidence: sorted(evidenceSnapshots.map(data).filter((item): item is ApprovalDocument => item !== null)),
      findings: sorted(findingsSnapshot.docs.map((snapshot) => data(snapshot)!)), repositories: sorted(repositoriesSnapshot.docs.map((snapshot) => data(snapshot)!)), warnings: [...new Set(warnings)].sort(), issues,
    };
  }
  async load(pointer: ApprovalPointer): Promise<ApprovalContext> { return this.db.runTransaction((tx) => this.loadWithin(tx, pointer)); }
  async complete(pointer: ApprovalPointer, evaluationId: string, expectedDigest: string | null, outcome: ApprovalOutcome, config: ApprovalConfig): Promise<"auto_approved" | "human_required" | "skipped"> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.ref("rule_versions", pointer.versionId), version = data(await tx.get(ref));
      if (!version || version.ownerWorkspaceId !== pointer.workspaceId || version.status !== "proposed" || version.deletedAt || reviewOf(version).evaluationId !== evaluationId || reviewOf(version).state !== "evaluating") return "skipped";
      const rule = idValid(version.ruleId) ? data(await tx.get(this.ref("rules", version.ruleId))) : null;
      const projectId = rule ? projectIdOf(rule) : null;
      const project = rule && rule.ownerWorkspaceId === pointer.workspaceId && !rule.deletedAt && projectId ? data(await tx.get(this.ref("projects", projectId))) : null;
      if (!rule || rule.ownerWorkspaceId !== pointer.workspaceId || rule.deletedAt || (projectId && (!project || project.ownerWorkspaceId !== pointer.workspaceId || project.deletedAt || project.status !== "active"))) return "skipped";
      let context: ApprovalContext | null = null, final = outcome;
      if (!Number.isFinite(Date.parse(String(reviewOf(version).leaseExpiresAt))) || Date.parse(String(reviewOf(version).leaseExpiresAt)) <= Date.now()) final = { state: "human_required", reasonCodes: ["REVIEW_EXPIRED"], wouldAutoApprove: false };
      else if (expectedDigest === null) final = { state: "human_required", reasonCodes: ["CONTEXT_UNAVAILABLE"], wouldAutoApprove: false };
      else {
        context = await this.loadWithin(tx, pointer);
        if (contextDigest(context) !== expectedDigest) final = { state: "human_required", reasonCodes: ["CONTEXT_CHANGED"], wouldAutoApprove: false };
        else if (outcome.state === "auto_approved") final = decideApproval(context, config, outcome.signals);
      }
      const now = new Date().toISOString();
      const review: ApprovalDocument = { ...final, evaluationId, policyVersion: APPROVAL_POLICY_VERSION, rubricVersion: APPROVAL_RUBRIC_VERSION,
        mode: config.mode, model: config.model, armorTemplate: config.armorTemplate, checkedAt: now,
        inputHash: expectedDigest, baseVersionId: context?.currentVersion?.id ?? null, minJudgeScore: config.minJudgeScore, minGroundednessConfidence: config.minGroundednessConfidence,
        approvalActor: final.state === "auto_approved" ? actor : null, compilePending: false,
      };
      if (final.state === "human_required" || !context?.currentVersion) {
        review.state = "human_required";
        tx.update(ref, { approvalReview: review, updatedAt: now });
        await this.audit(tx, pointer, "rule_version.escalate", evaluationId, review);
        return "human_required";
      }
      const targets = new Set(Array.isArray(version.driftFindingIds) ? version.driftFindingIds : []);
      const unresolved = context.findings.some((finding) => !targets.has(finding.id) && ["open", "accepted"].includes(String(finding.status)));
      const repositories = context.repositories.filter((repository) => repository.status === "active");
      review.compilePending = repositories.length > 0;
      review.pendingCompileRepositoryIds = repositories.map((repository) => repository.id);
      // Every relevant document/query has been read before the first write.
      tx.update(this.ref("rule_versions", context.currentVersion.id), { status: "superseded", effectiveTo: now, updatedAt: now });
      tx.update(ref, { status: "approved", approvedBy: null, approvedAt: now, effectiveFrom: now, approvalReview: review, updatedAt: now });
      tx.update(this.ref("rules", context.rule.id), { currentVersionId: pointer.versionId, status: unresolved ? "stale" : "active", staleSince: unresolved ? context.rule.staleSince ?? now : null, updatedAt: now });
      for (const finding of context.findings) if (targets.has(finding.id)) tx.update(this.ref("drift_findings", finding.id), { status: "resolved", resolvedByRuleVersionId: pointer.versionId, resolvedAt: now, updatedAt: now });
      const memoryId = generateUlid();
      const inherited = Object.fromEntries(["scopeType", "scopeId", "visibility", "enforcement", "transferPolicy", "licenseType", "provenance", "containsPersonalData", "containsConfidentialData", "retentionClass", "projectId"].map((key) => [key, context!.rule[key] ?? null]));
      tx.create(this.ref("decision_memories", memoryId), { ...inherited, id: memoryId, ownerWorkspaceId: pointer.workspaceId, createdBy: actor, createdAt: now, updatedAt: now, deletedAt: null,
        title: `${String(context.rule.title)} v${String(version.version)}`, context: "委任された低リスクルールの保守更新", decision: version.rationale,
        consequences: `自動承認（${APPROVAL_POLICY_VERSION}）。GitHubへの反映には人間のPRマージが必要。`,
        linkedRuleIds: [context.rule.id], linkedEvidenceIds: version.evidenceIds ?? [],
        approvedRuleVersionId: pointer.versionId,
        approvedRuleVersionNumber: typeof version.version === "number" ? version.version : null,
        approvedChangeType: typeof version.changeType === "string" ? version.changeType : null,
        approvalComment: null, approvalMode: "automatic",
        sourceType: "approval", status: "active",
      });
      await this.audit(tx, pointer, "rule_version.auto_approve", evaluationId, review);
      return "auto_approved";
    });
  }
  async flushCompilations(workspaceId: string, onDispatchFailure?: () => void): Promise<number> {
    const snapshots = await this.db.collection("rule_versions").where("ownerWorkspaceId", "==", workspaceId).where("approvalReview.compilePending", "==", true).limit(20).get();
    let dispatched = 0;
    for (const snapshot of snapshots.docs) {
      const version = data(snapshot)!, review = reviewOf(version);
      if (review.state !== "auto_approved" || !Array.isArray(review.pendingCompileRepositoryIds)) continue;
      let complete = true;
      for (const repositoryId of review.pendingCompileRepositoryIds) {
        try {
          const repository = data(await this.ref("repositories", repositoryId).get());
          if (!repository || repository.ownerWorkspaceId !== workspaceId || repository.status !== "active") continue;
          await this.store.createAnalysisJob({ workspaceId, actorUserId: null, actorKind: "system" }, {
            type: "compile", projectId: String(repository.projectId), payload: { repositoryId, ruleVersionId: snapshot.id }, idempotencyKey: `compile:${repositoryId}:${snapshot.id}`, requestId: `approval-compile:${review.evaluationId}`,
          });
          dispatched += 1;
        } catch {
          complete = false;
          // Report only an occurrence, never repository data or the raw exception.
          try { onDispatchFailure?.(); } catch { /* Telemetry must not interrupt outbox recovery. */ }
        }
      }
      // Durable outbox intent is cleared only after successful/idempotent dispatches.
      if (complete) await this.db.runTransaction(async (tx) => {
        const current = data(await tx.get(snapshot.ref));
        if (current && current.ownerWorkspaceId === workspaceId && reviewOf(current).evaluationId === review.evaluationId) tx.update(snapshot.ref, { "approvalReview.compilePending": false });
      });
    }
    return dispatched;
  }
}