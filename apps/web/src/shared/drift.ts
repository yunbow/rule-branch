import { requireRole } from "./authz.ts";
import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, projectIdForRule, requireHumanActor, RuleStoreError, type DocumentData } from "./rulestore.ts";
import { userActor, userContext } from "./service-context.ts";

const MANUAL_DRIFT_SCAN_COOLDOWN_MS = 5 * 60 * 1000;

export class DriftService {
  readonly store: FirestoreRuleStore;
  constructor(store: FirestoreRuleStore) { this.store = store; }
  private ctx(workspaceId: string, userId: string | null) { return userContext(workspaceId, userId); }
  async trigger(workspaceId: string, userId: string | null, projectId: string) {
    await requireRole(this.store, workspaceId, userId, "member"); const ctx = this.ctx(workspaceId, userId), project = await this.store.get(ctx, "projects", projectId);
    if (!project) throw new RuleStoreError("NOT_FOUND", 404);
    const repositories = (await this.store.list(ctx, "repositories", { projectId, status: "active" }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (!repositories.length) throw new RuleStoreError("NO_ACTIVE_REPOSITORIES", 422);
    const activeJobs = (await Promise.all(["queued", "running"].map((status) =>
      this.store.list(ctx, "analysis_jobs", { projectId, status })))).flat();
    const cooldown = Math.floor(Date.now() / MANUAL_DRIFT_SCAN_COOLDOWN_MS);
    const jobIds: string[] = [];
    for (const repository of repositories) {
      const active = activeJobs.find((job) => job.type === "drift_scan"
        && (job.payload as DocumentData | undefined)?.repositoryId === repository.id);
      if (active) { jobIds.push(String(active.id)); continue; }
      // Stable trigger identity also prevents orphan triggers on concurrent clicks.
      const id = `manual-${projectId}-${repository.id}-${cooldown}`, now = new Date().toISOString();
      await this.store.runTransaction(async tx => {
        const ref = this.store.documentRef("change_triggers", id), snapshot = await tx.get(ref);
        await this.store.requireActiveProject(tx, ctx, projectId);
        if (!snapshot.exists) tx.create(ref, {
          id, ownerWorkspaceId: workspaceId, projectId, type: "manual_review",
          source: { projectId, repositoryId: repository.id }, detectedBy: "user",
          resultingFindingIds: [], processedAt: null, truncation: null,
          createdAt: now, updatedAt: now, deletedAt: null,
        });
      });
      const result = await this.store.createAnalysisJob(ctx, {
        type: "drift_scan", projectId, payload: { triggerId: id, repositoryId: repository.id },
        idempotencyKey: `drift_scan:${id}`, requestId: `drift:${id}`,
      });
      jobIds.push(result.job.id);
    }
    return { jobId: jobIds[0]!, jobIds };

  }
  async list(workspaceId: string, userId: string | null) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId), "drift_findings"); }
  async listForRule(workspaceId: string, userId: string | null, ruleId: string) {
    await requireRole(this.store, workspaceId, userId, "viewer");
    const ctx = this.ctx(workspaceId, userId);
    return (await Promise.all(["open", "accepted"].map((status) => this.store.listQuery(ctx, "drift_findings", [
      { field: "ruleId", op: "==", value: ruleId },
      { field: "status", op: "==", value: status },
    ], { limit: 100 })))).flat();
  }
  /** Proposal creation is deliberately an explicit human request; scans never call this. */
  async propose(workspaceId: string, userId: string | null, id: string, requestId?: unknown): Promise<{ jobId: string }> {
    const ctx = this.ctx(workspaceId, userId); requireHumanActor(ctx, "proposeDriftFinding"); await requireRole(this.store, workspaceId, userId, "maintainer");
    const finding = await this.store.get(ctx, "drift_findings", id); if (!finding) throw new RuleStoreError("NOT_FOUND", 404);
    if (finding.status !== "accepted") throw new RuleStoreError("DRIFT_FINDING_NOT_ACCEPTED", 422);
    const workspace = await this.store.get(ctx, "workspaces", workspaceId);
    if (workspace?.settings && (workspace.settings as DocumentData).allowAiAutoProposal === false) throw new RuleStoreError("AI_AUTO_PROPOSAL_DISABLED", 422);
    if (typeof finding.ruleId !== "string" || typeof finding.ruleVersionId !== "string") throw new RuleStoreError("FINDING_BASE_VERSION_REQUIRED", 422, { driftFindingId: id });
    const rule = await this.store.get(ctx, "rules", finding.ruleId);
    if (!rule) throw new RuleStoreError("NOT_FOUND", 404);
    if (rule.currentVersionId !== finding.ruleVersionId) throw new RuleStoreError("FINDING_BASE_VERSION_STALE", 409, { driftFindingId: id });
    let projectId = typeof rule.projectId === "string" ? rule.projectId : null;
    if (typeof finding.projectId === "string" && projectId && finding.projectId !== projectId) throw new RuleStoreError("NOT_FOUND", 404);
    if (!projectId) projectId = typeof finding.projectId === "string" ? finding.projectId : null;
    if (!projectId && typeof finding.triggerId === "string") {
      const trigger = await this.store.get(ctx, "change_triggers", finding.triggerId);
      if (typeof trigger?.projectId === "string") projectId = trigger.projectId;
    }
    if (!projectId && typeof finding.sourceJobId === "string") { const sourceJob = await this.store.get(ctx, "analysis_jobs", finding.sourceJobId); if (typeof sourceJob?.projectId === "string") projectId = sourceJob.projectId; }
    if (!projectId && typeof finding.repositoryId === "string") { const repository = await this.store.get(ctx, "repositories", finding.repositoryId); if (typeof repository?.projectId === "string") projectId = repository.projectId; }
    if (!projectId) throw new RuleStoreError("FINDING_PROJECT_REQUIRED", 422, { driftFindingId: id });
    const token = typeof requestId === "string" && requestId ? requestId : crypto.randomUUID();
    const result = await this.store.createAnalysisJob(ctx, { type: "proposal", projectId, payload: { driftFindingId: id, baseRuleVersionId: finding.ruleVersionId }, idempotencyKey: `proposal:${id}:${token}`, requestId: token });
    return { jobId: result.job.id };
  }
  async triage(workspaceId: string, userId: string | null, id: string, action: "accept" | "dismiss" | "reopen" | "untriage", dismissReason?: unknown): Promise<DocumentData> {
    const ctx = this.ctx(workspaceId, userId); requireHumanActor(ctx, "triageDriftFinding"); await requireRole(this.store, workspaceId, userId, "maintainer");
    if (action === "dismiss" && (typeof dismissReason !== "string" || !dismissReason.trim())) throw new RuleStoreError("DISMISS_REASON_REQUIRED", 422);
    const finding = await this.store.get(ctx, "drift_findings", id); if (!finding) throw new RuleStoreError("NOT_FOUND", 404);
    return this.store.runTransaction(async tx => {
      const ref = this.store.documentRef("drift_findings", id), snapshot = await tx.get(ref), current = snapshot.data(); if (!snapshot.exists || !current || current.ownerWorkspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      const allowed = action === "accept" || action === "dismiss" ? current.status === "open" : action === "reopen" ? ["dismissed", "expired"].includes(String(current.status)) : current.status === "accepted";
      if (!allowed) throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from: current.status, action });
      const ruleRef = this.store.documentRef("rules", current.ruleId as string), ruleSnapshot = await tx.get(ruleRef), rule = ruleSnapshot.data();
      if (!ruleSnapshot.exists || !rule || rule.ownerWorkspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      // Refresh on every transaction retry. A snapshot collected before the
      // transaction leaves the Rule stale when two findings are dismissed together.
      const findings = await this.store.list(ctx, "drift_findings", { ruleId: current.ruleId });
      const projectId = projectIdForRule(rule); if (projectId) await this.store.requireActiveProject(tx, ctx, projectId);
      const now = new Date().toISOString(), status = action === "accept" ? "accepted" : action === "dismiss" ? "dismissed" : "open";
      const patch: DocumentData = { status, updatedAt: now, triagedBy: action === "untriage" || action === "reopen" ? null : userId, triagedAt: action === "untriage" || action === "reopen" ? null : now, dismissReason: action === "dismiss" ? dismissReason : action === "untriage" ? null : current.dismissReason ?? null, proposalVersionId: action === "untriage" || action === "reopen" ? null : current.proposalVersionId ?? null, reopenCount: Number(current.reopenCount ?? 0) + (action === "reopen" || action === "untriage" ? 1 : 0) };
      const post = findings.map(x => x.id === id ? { ...x, ...patch } : x);
      tx.update(ref, patch);
      if ((action === "reopen" || action === "untriage") && rule.status === "active") tx.update(ruleRef, { status: "stale", staleSince: now, updatedAt: now });
      else if (rule.status === "stale" && !post.some(item => ["open", "accepted"].includes(String(item.status)))) tx.update(ruleRef, { status: "active", staleSince: null, updatedAt: now });
      else tx.update(ruleRef, { updatedAt: now }); // Serialize concurrent triage even if status is unchanged.
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: `drift.${action}`, targetType: "drift_findings", targetId: id, requestId: `drift:${id}:${action}`, before: { status: current.status }, after: { status } }, tx); return { ...current, ...patch };
    });
  }
}

