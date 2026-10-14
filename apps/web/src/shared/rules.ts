import { requireRole } from "./authz.ts";
import { canApproveRuleVersion, canRestoreArchivedRule, hasRole, type WorkspaceKind } from "./permissions.ts";
import { ENUMS } from "./contracts.ts";
import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, assertRelationScopeCoverage, canonicalJson, pendingRuleCompilationPatch, projectIdForRule, repositoryTargetsForRule, RuleStoreError, type CreateRuleRelationInput, type CreateRuleVersionInput, type DocumentData } from "./rulestore.ts";
import { userActor, userContext } from "./service-context.ts";

const KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const RULE_VERSION_STATUSES = new Set(["proposed", "approved", "rejected", "superseded", "withdrawn"]);
const RULE_CHECK_KINDS = new Set(["regex", "glob", "ast-grep", "lint-rule", "ci-command"]);
const RULE_CHECK_SEVERITIES = new Set(["info", "warning", "error"]);
const RULE_CHECK_FIELDS = new Set(["kind", "spec", "severityOnFail", "enabled"]);
/** Keep creation and metadata updates on the same runtime validation boundary. */
function validateRuleTitle(title: unknown): void {
  if (typeof title !== "string" || !title.trim() || title.length > 160) {
    throw new RuleStoreError("INVALID_RULE", 422, { field: "title" });
  }
}
const values = (value: unknown, maximum: number, error: string): string[] => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || value.length > maximum) throw new RuleStoreError(error, 422, { maximum });
  return value;
};
export interface CreateRuleInput extends DocumentData { key: string; scopeType: string; scopeId: string; layer: string; type: string; evaluationMode: string; enforcement: string; visibility?: string; projectId?: string | null; selector?: DocumentData; checks?: DocumentData[]; requestId?: string; }

/** Rule metadata and immutable-version entry points. Lifecycle transitions live in IMPL-009. */
export class RulesService {
  readonly store: FirestoreRuleStore;
  constructor(store: FirestoreRuleStore) { this.store = store; }
  private ctx(workspaceId: string, userId: string | null) { return userContext(workspaceId, userId); }
  private selector(input: DocumentData | undefined): DocumentData {
    const source = input ?? {}, selector: DocumentData = {};
    for (const [field, maximum] of [["languages", 20], ["frameworks", 20], ["directoryGlobs", 50], ["dependencies", 50], ["repositoryIds", 50]] as const) selector[field] = values(source[field], maximum, "INVALID_SELECTOR");
    return selector;
  }
  private checks(input: unknown): DocumentData[] {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new RuleStoreError("INVALID_RULE_CHECK", 422);
    return input.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RuleStoreError("INVALID_RULE_CHECK", 422, { index });
      const check = value as DocumentData;
      if (Object.keys(check).some((field) => !RULE_CHECK_FIELDS.has(field)) || !RULE_CHECK_KINDS.has(String(check.kind))) throw new RuleStoreError("INVALID_RULE_CHECK", 422, { index });
      if (typeof check.spec !== "object" || check.spec === null || Array.isArray(check.spec)) throw new RuleStoreError("INVALID_RULE_CHECK", 422, { index, field: "spec" });
      if (check.severityOnFail !== undefined && !RULE_CHECK_SEVERITIES.has(String(check.severityOnFail))) throw new RuleStoreError("INVALID_RULE_CHECK", 422, { index, field: "severityOnFail" });
      if (check.enabled !== undefined && typeof check.enabled !== "boolean") throw new RuleStoreError("INVALID_RULE_CHECK", 422, { index, field: "enabled" });
      return { kind: check.kind, spec: check.spec, severityOnFail: check.severityOnFail ?? "warning", enabled: check.enabled ?? true };
    });
  }
  private async validateRule(workspaceId: string, userId: string, input: CreateRuleInput, selector: DocumentData): Promise<void> {
    if (!KEY.test(input.key) || !ENUMS.scopeType.includes(input.scopeType)) throw new RuleStoreError("INVALID_RULE", 422);
    if (input.visibility !== undefined && (!ENUMS.visibility.includes(input.visibility) || input.visibility !== "private" && input.visibility !== "organization")) throw new RuleStoreError("INVALID_RULE", 422, { field: "visibility" });
    // The API receives JSON, not a TypeScript-validated object. Check compiler-facing
    // enums before persisting a rule that could later fail the entire publication.
    for (const [field, values] of [
      ["layer", ENUMS["rules.layer"]], ["type", ENUMS["rules.type"]],
      ["evaluationMode", ENUMS["rules.evaluationMode"]], ["enforcement", ENUMS.enforcement],
      ["transferPolicy", ENUMS.transferPolicy], ["licenseType", ENUMS.licenseType],
    ] as const) {
      const value = input[field];
      if ((value == null && (field === "transferPolicy" || field === "licenseType"))) continue;
      if (typeof value !== "string" || !values.includes(value)) throw new RuleStoreError("INVALID_RULE", 422, { field });
    }
    validateRuleTitle(input.title);
    if (input.scopeType === "organization" && input.scopeId !== workspaceId) throw new RuleStoreError("INVALID_RULE", 422, { field: "scopeId" });
    if (input.scopeType === "project" && input.scopeId !== input.projectId) throw new RuleStoreError("INVALID_RULE", 422, { field: "scopeId" });
    if (input.scopeType === "user" && input.scopeId !== userId) throw new RuleStoreError("INVALID_RULE", 422, { field: "scopeId" });
    if (input.scopeType === "team" || ["team", "public"].includes(input.visibility ?? "private")) throw new RuleStoreError("INVALID_SCOPE_VISIBILITY", 422);
    if (input.scopeType === "user" && (input.enforcement !== "personal" || input.type !== "interaction")) throw new RuleStoreError("INVALID_ENFORCEMENT", 422);
    if (input.enforcement === "locked" && input.scopeType !== "organization") throw new RuleStoreError("INVALID_ENFORCEMENT", 422);
    if (input.scopeType === "project" ? typeof input.projectId !== "string" || !input.projectId : input.projectId != null) throw new RuleStoreError("INVALID_PROJECT_ID", 422);
    const repositoryIds = selector.repositoryIds as string[];
    if (input.scopeType !== "project" && repositoryIds.length) throw new RuleStoreError("INVALID_SELECTOR_REPOSITORIES", 422);
    if (input.scopeType === "project") {
      const project = await this.store.get(this.ctx(workspaceId, "system"), "projects", input.projectId!); if (!project) throw new RuleStoreError("NOT_FOUND", 404);
      const repositories = await this.store.list(this.ctx(workspaceId, "system"), "repositories", { projectId: input.projectId });
      if (repositoryIds.some((id) => !repositories.some((repository) => repository.id === id && repository.status === "active"))) throw new RuleStoreError("INVALID_SELECTOR_REPOSITORIES", 422);
    }
    if (input.evaluationMode === "deterministic" && (!Array.isArray(input.checks) || !input.checks.length)) throw new RuleStoreError("RULE_CHECKS_REQUIRED", 422);
  }
  async createRule(workspaceId: string, userId: string | null, input: CreateRuleInput): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "member");
    if (input.nextVersion !== undefined || input.currentVersionId !== undefined || input.status !== undefined) throw new RuleStoreError("IMMUTABLE_FIELD", 409);
    const selector = this.selector(input.selector), checks = this.checks(input.checks), tags = values(input.tags, 20, "INVALID_TAGS"), watchDependencies = values((input.maintenance as DocumentData | undefined)?.watchDependencies, 50, "INVALID_MAINTENANCE");
    await this.validateRule(workspaceId, userId!, { ...input, checks }, selector);
    const id = generateUlid(), now = new Date().toISOString(), ctx = this.ctx(workspaceId, userId!), requestId = input.requestId ?? `rule:${id}`;
    return this.store.runTransaction(async (tx) => {
      if (input.scopeType === "project") await this.store.requireActiveProject(tx, ctx, input.projectId!);
      await this.store.reserveUniqueKey(tx, "rule_key", { ownerWorkspaceId: workspaceId, scopeType: input.scopeType, scopeId: input.scopeId, key: input.key }, { targetTable: "rules", targetId: id });
      const rule: DocumentData = { id, ownerWorkspaceId: workspaceId, scopeType: input.scopeType, scopeId: input.scopeId, visibility: input.visibility ?? "private", enforcement: input.enforcement, transferPolicy: input.transferPolicy ?? (input.layer === "L3" ? "project-only" : "exportable"), licenseType: input.licenseType ?? "proprietary-customer", provenance: input.provenance ?? { sourceType: "human", sourceRef: null, derivedFromCustomerCode: false }, containsPersonalData: input.containsPersonalData ?? false, containsConfidentialData: input.containsConfidentialData ?? false, retentionClass: input.retentionClass ?? "standard", createdBy: userActor(userId!), createdAt: now, updatedAt: now, deletedAt: null, projectId: input.projectId ?? null, currentVersionId: null, nextVersion: 1, key: input.key, title: input.title, layer: input.layer, type: input.type, evaluationMode: input.evaluationMode, status: "draft", selector, ownerUserId: input.ownerUserId ?? null, maintenance: { reviewIntervalDays: null, expiresAt: null, ...(input.maintenance ?? {}), watchDependencies }, supersededByRuleId: null, staleSince: null, tags };
      tx.create(this.store.documentRef("rules", id), rule);
      for (const check of checks) {
        const checkId = generateUlid();
        tx.create(this.store.documentRef("rule_checks", checkId), {
          ...check,
          id: checkId,
          ownerWorkspaceId: workspaceId,
          scopeType: rule.scopeType,
          scopeId: rule.scopeId,
          visibility: rule.visibility,
          enforcement: null,
          transferPolicy: rule.transferPolicy,
          licenseType: rule.licenseType,
          provenance: rule.provenance,
          containsPersonalData: rule.containsPersonalData,
          containsConfidentialData: rule.containsConfidentialData,
          retentionClass: rule.retentionClass,
          createdBy: rule.createdBy,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          ruleId: id,
        });
      }
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "rule.create", targetType: "rules", targetId: id, requestId, after: { key: input.key } }, tx);
      return rule;
    });
  }
  async updateRuleMetadata(workspaceId: string, userId: string | null, id: string, patch: DocumentData): Promise<DocumentData> {
    const role = await requireRole(this.store, workspaceId, userId, "member");
    const kind = await this.workspaceKind(workspaceId);
    const allowed = new Set(["title", "tags", "selector", "maintenance", "ownerUserId"]); if (!Object.keys(patch).length || Object.keys(patch).some((key) => !allowed.has(key))) throw new RuleStoreError("IMMUTABLE_FIELD", 409);
    if (Object.prototype.hasOwnProperty.call(patch, "title")) validateRuleTitle(patch.title);
    const ctx = this.ctx(workspaceId, userId!);
    const repositories = patch.selector !== undefined ? await this.store.list(ctx, "repositories", { status: "active" }) : [];
    const updated = await this.store.runTransaction(async (tx) => {
      const ref = this.store.documentRef("rules", id), snapshot = await tx.get(ref), rule = snapshot.data();
      if (!snapshot.exists || !rule || rule.ownerWorkspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      const next: DocumentData = { ...patch, updatedAt: new Date().toISOString() };
      if (patch.tags !== undefined) next.tags = values(patch.tags, 20, "INVALID_TAGS");
      if (patch.selector !== undefined) {
        const nextSelector = this.selector(patch.selector as DocumentData); next.selector = nextSelector;
        // A previously valid relation must not silently become an invalid
        // repository-wide exception after either rule's selector changes.
        const related = await Promise.all([
          tx.getQuery(this.store.queryRef("rule_relations", { ownerWorkspaceId: workspaceId, parentRuleId: id })),
          tx.getQuery(this.store.queryRef("rule_relations", { ownerWorkspaceId: workspaceId, childRuleId: id })),
        ]);
        for (const relation of related.flatMap((query) => query.docs).map((doc) => doc.data()).filter((value): value is DocumentData => Boolean(value) && !value?.deletedAt)) {
          const relationType = String(relation.relationType);
          if (relationType !== "override" && relationType !== "deny") continue;
          const otherId = relation.parentRuleId === id ? relation.childRuleId : relation.parentRuleId;
          if (typeof otherId !== "string") throw new RuleStoreError("RELATION_SCOPE_INVALID", 422);
          const otherSnapshot = await tx.get(this.store.documentRef("rules", otherId));
          const other = otherSnapshot.data();
          if (!otherSnapshot.exists || !other || other.deletedAt || other.ownerWorkspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
          const edited = { ...rule, selector: nextSelector };
          assertRelationScopeCoverage(
            relation.parentRuleId === id ? edited : other,
            relation.childRuleId === id ? edited : other,
            relationType,
          );
        }
        if (rule.currentVersionId && canonicalJson(this.selector(rule.selector as DocumentData | undefined)) !== canonicalJson(nextSelector)
          && !canApproveRuleVersion({ workspaceKind: kind, enforcement: rule.enforcement as never, scopeType: rule.scopeType as never }, role)) {
          throw new RuleStoreError("FORBIDDEN", 403, { operation: "changeApprovedRuleScope" });
        }
        const repositoryIds = nextSelector.repositoryIds as string[];
        if (rule.scopeType !== "project" && repositoryIds.length) throw new RuleStoreError("INVALID_SELECTOR_REPOSITORIES", 422);
        if (rule.scopeType === "project" && repositoryIds.length) {
          if (repositoryIds.some((repositoryId) => !repositories.some((repository) => repository.id === repositoryId && repository.status === "active" && repository.projectId === rule.projectId))) throw new RuleStoreError("INVALID_SELECTOR_REPOSITORIES", 422);
        }
        if (canonicalJson(this.selector(rule.selector as DocumentData | undefined)) !== canonicalJson(nextSelector)) {
          const before = repositoryTargetsForRule(rule, repositories);
          const after = repositoryTargetsForRule({ ...rule, selector: nextSelector }, repositories);
          Object.assign(next, pendingRuleCompilationPatch(rule, [...before, ...after]));
        }
      }
      if (patch.maintenance !== undefined) {
        if (!patch.maintenance || typeof patch.maintenance !== "object" || Array.isArray(patch.maintenance)) throw new RuleStoreError("INVALID_MAINTENANCE", 422);
        const maintenancePatch = patch.maintenance as DocumentData;
        next.maintenance = {
          ...(rule.maintenance as DocumentData | undefined ?? {}),
          ...maintenancePatch,
          ...(Object.prototype.hasOwnProperty.call(maintenancePatch, "watchDependencies")
            ? { watchDependencies: values(maintenancePatch.watchDependencies, 50, "INVALID_MAINTENANCE") } : {}),
        };
      }
      const projectId = projectIdForRule(rule); if (projectId) await this.store.requireActiveProject(tx, ctx, projectId);
      tx.update(ref, next);
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "rule.metadata_update", targetType: "rules", targetId: id, requestId: `rule-update:${id}`, before: rule, after: { ...rule, ...next } }, tx);
      return { ...rule, ...next };
    });
    if (updated.compilePending === true) await this.store.flushRuleCompilations(ctx, id).catch(() => {});
    return updated;
  }
  async createRuleVersion(workspaceId: string, userId: string | null, ruleId: string, input: CreateRuleVersionInput): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "member");
    if ((input.provenance as DocumentData | undefined)?.sourceType === "ai" && !(input.evidenceIds ?? []).length) throw new RuleStoreError("EVIDENCE_REQUIRED", 422);
    // Provenance and drift linkage are server-owned. A human correction inherits
    // its finding linkage from the immutable superseded version in RuleStore.
    return this.store.createRuleVersion(this.ctx(workspaceId, userId!), ruleId, {
      ...input,
      provenance: { sourceType: "human", sourceRef: null, derivedFromCustomerCode: false },
      triggerId: null,
      driftFindingIds: [],
      aiSummary: null,
    });
  }
  private async workspaceKind(workspaceId: string): Promise<WorkspaceKind> { const workspace = await this.store.documentRef("workspaces", workspaceId).get(); return (workspace.data()?.kind as WorkspaceKind | undefined) ?? "organization"; }
  async approveRuleVersion(workspaceId: string, userId: string | null, id: string, options: { comment?: string; requestId?: string } = {}): Promise<DocumentData> {
    if (!userId) throw new RuleStoreError("FORBIDDEN", 403, { operation: "approveRuleVersion" });
    const version = await this.store.get(this.ctx(workspaceId, userId), "rule_versions", id); if (!version) throw new RuleStoreError("NOT_FOUND", 404);
    const rule = await this.store.get(this.ctx(workspaceId, userId), "rules", version.ruleId as string); if (!rule) throw new RuleStoreError("NOT_FOUND", 404);
    const role = await requireRole(this.store, workspaceId, userId, "member");
    if (!canApproveRuleVersion({ workspaceKind: await this.workspaceKind(workspaceId), enforcement: rule.enforcement as never, scopeType: rule.scopeType as never }, role)) throw new RuleStoreError("FORBIDDEN", 403, { operation: "approveRuleVersion" });
    return this.store.approveRuleVersion(this.ctx(workspaceId, userId), id, options);
  }
  async rejectRuleVersion(workspaceId: string, userId: string | null, id: string, reason: unknown): Promise<DocumentData> { await requireRole(this.store, workspaceId, userId, "member"); if (typeof reason !== "string" || !reason.trim()) throw new RuleStoreError("REJECTION_REASON_REQUIRED", 422); return this.store.rejectRuleVersion(this.ctx(workspaceId, userId!), id, reason); }
  async withdrawRuleVersion(workspaceId: string, userId: string | null, id: string): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "member");
    const ctx = this.ctx(workspaceId, userId!), version = await this.store.get(ctx, "rule_versions", id);
    if (!version) throw new RuleStoreError("NOT_FOUND", 404);
    const creator = version.createdBy as DocumentData | undefined;
    // AI proposals are withdrawn only by the atomic `createRuleVersion(...supersedes)`
    // replacement path. The public action is intentionally limited to its human creator.
    if (creator?.kind !== "user" || creator.id !== userId) throw new RuleStoreError("FORBIDDEN", 403, { operation: "withdrawRuleVersion" });
    return this.store.withdrawRuleVersion(ctx, id);
  }
  async updateRuleStatus(workspaceId: string, userId: string | null, id: string, status: unknown, opts: { rationale?: unknown; supersededByRuleId?: unknown; approvedVersionId?: unknown; requestId?: string } = {}): Promise<DocumentData> {
    if (typeof status !== "string") throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422);
    if (!userId && ["deprecated", "superseded", "archived"].includes(status)) throw new RuleStoreError("FORBIDDEN", 403, { operation: "updateRuleStatus" });
    const role = await requireRole(this.store, workspaceId, userId, "member"); const ctx = this.ctx(workspaceId, userId!), rule = await this.store.get(ctx, "rules", id); if (!rule) throw new RuleStoreError("NOT_FOUND", 404);
    const validTransition = (from: string) => (from === "draft" && status === "archived") || (["active", "stale"].includes(from) && ["deprecated", "superseded"].includes(status)) || (["deprecated", "superseded"].includes(from) && status === "archived") || (from === "archived" && status === "active");
    const from = String(rule.status);
    if (from === "active" && status === "active" && typeof opts.approvedVersionId === "string" && opts.approvedVersionId === rule.currentVersionId
        && canRestoreArchivedRule(await this.workspaceKind(workspaceId), role)) {
      // A previous response may have failed after committing approval but before
      // Cloud Tasks dispatch. Retry only the persisted compile intent.
      const version = await this.store.get(ctx, "rule_versions", opts.approvedVersionId);
      if (version?.compilePending === true) await this.store.onRuleVersionApproved(opts.approvedVersionId, ctx);
      return rule;
    }
    if (!validTransition(from)) throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from, to: status });
    if (from !== "draft" && !canApproveRuleVersion({ workspaceKind: await this.workspaceKind(workspaceId), enforcement: rule.enforcement as never, scopeType: rule.scopeType as never }, role)) {
      throw new RuleStoreError("FORBIDDEN", 403, { operation: "changeApprovedRuleStatus" });
    }
    if (status === "deprecated" && (typeof opts.rationale !== "string" || !opts.rationale.trim())) throw new RuleStoreError("RATIONALE_REQUIRED", 422);
    if (status === "superseded" && (typeof opts.supersededByRuleId !== "string" || !opts.supersededByRuleId)) throw new RuleStoreError("SUPERSEDED_BY_RULE_REQUIRED", 422);
    if (status === "active" && !canRestoreArchivedRule(await this.workspaceKind(workspaceId), role)) throw new RuleStoreError("FORBIDDEN", 403, { operation: "restoreArchivedRule" });
    if (status === "active") {
      if (typeof opts.approvedVersionId !== "string") throw new RuleStoreError("APPROVED_VERSION_REQUIRED", 422);
      const version = await this.store.get(ctx, "rule_versions", opts.approvedVersionId);
      if (!version || version.ruleId !== id) throw new RuleStoreError("APPROVED_VERSION_INVALID", 422);
      // Do not enqueue compilation while the rule is still archived. Approval,
      // active status, audit and durable compile intent are committed together.
      await this.store.approveRuleVersion(ctx, opts.approvedVersionId, { requestId: opts.requestId, restoreArchived: true });
      const restored = await this.store.get(ctx, "rules", id);
      if (!restored) throw new RuleStoreError("NOT_FOUND", 404);
      return restored;
    }
    const repositories = await this.store.list(ctx, "repositories", { status: "active" });
    const updated = await this.store.runTransaction(async (tx) => {
      const ref = this.store.documentRef("rules", id), snap = await tx.get(ref), current = snap.data();
      if (!snap.exists || !current || current.ownerWorkspaceId !== workspaceId || current.deletedAt) throw new RuleStoreError("NOT_FOUND", 404);
      if (!validTransition(String(current.status))) throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from: current.status, to: status });
      if (status === "superseded") {
        const targetId = opts.supersededByRuleId as string;
        const targetSnapshot = await tx.get(this.store.documentRef("rules", targetId));
        const target = targetSnapshot.data();
        if (targetId === id || !targetSnapshot.exists || !target || target.deletedAt
          || target.ownerWorkspaceId !== workspaceId || target.scopeType !== current.scopeType
          || target.scopeId !== current.scopeId || target.projectId !== current.projectId
          || !["active", "stale"].includes(String(target.status))) {
          throw new RuleStoreError("SUPERSEDED_BY_RULE_INVALID", 422);
        }
      }
      const projectId = projectIdForRule(current); if (projectId) await this.store.requireActiveProject(tx, ctx, projectId);
      const now = new Date().toISOString(); const patch: DocumentData = { status, updatedAt: now, ...(status === "superseded" ? { supersededByRuleId: opts.supersededByRuleId } : {}), ...(status !== "superseded" ? { supersededByRuleId: null } : {}) };
      Object.assign(patch, pendingRuleCompilationPatch(current, repositoryTargetsForRule(current, repositories)));
      tx.update(ref, patch);
      if (current.status === "draft" && status === "archived") for (const version of await this.store.list(ctx, "rule_versions", { ruleId: id })) { if (version.status === "proposed") tx.update(this.store.documentRef("rule_versions", version.id as string), { status: "rejected", rejectionReason: "Rule archived", updatedAt: now }); }
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "rule.status_change", targetType: "rules", targetId: id, requestId: opts.requestId ?? `rule-status:${id}`, before: current, after: { ...current, ...patch, rationale: opts.rationale ?? null } }, tx); return { ...current, ...patch }; });
    if (updated.compilePending === true) await this.store.flushRuleCompilations(ctx, id).catch(() => {});
    return updated;
  }
  async listDecisionMemories(workspaceId: string, userId: string | null) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "decision_memories"); }
  async listDecisionMemoriesForRule(workspaceId: string, userId: string | null, projectId: string, ruleId: string) {
    await requireRole(this.store, workspaceId, userId, "viewer");
    const memories = await this.store.listQuery(this.ctx(workspaceId, userId!), "decision_memories", [{ field: "projectId", op: "==", value: projectId }], { orderBy: { field: "createdAt", direction: "desc" }, limit: 100 });
    return memories.filter((memory) => Array.isArray(memory.linkedRuleIds) && memory.linkedRuleIds.includes(ruleId));
  }
  async listReviewQueue(workspaceId: string, userId: string | null, limit = 100) {
    await requireRole(this.store, workspaceId, userId, "viewer");
    return this.store.listQuery(this.ctx(workspaceId, userId!), "rule_versions", [{ field: "status", op: "==", value: "proposed" }], { orderBy: { field: "createdAt", direction: "asc" }, limit });
  }
  async updateRuleVersion(_workspaceId: string, _userId: string | null, _id: string, _patch: DocumentData): Promise<never> { throw new RuleStoreError("IMMUTABLE_FIELD", 409); }
  async getRule(workspaceId: string, userId: string | null, id: string) { await requireRole(this.store, workspaceId, userId, "viewer"); const value = await this.store.get(this.ctx(workspaceId, userId!), "rules", id); if (!value) throw new RuleStoreError("NOT_FOUND", 404); return value; }
  async listRules(workspaceId: string, userId: string | null) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "rules"); }
  async listProjectRules(workspaceId: string, userId: string | null, projectId: string, status?: string) {
    await requireRole(this.store, workspaceId, userId, "viewer");
    const ctx = this.ctx(workspaceId, userId!);
    const [rules, jobs] = await Promise.all([this.store.list(ctx, "rules", { projectId, ...(status ? { status } : {}) }), this.store.list(ctx, "analysis_jobs", { projectId })]);
    const possiblePromptInjection = jobs.some((job) => Array.isArray(job.warnings) && job.warnings.some((warning) => (warning as DocumentData).code === "possible_prompt_injection"));
    return rules.map((rule) => ({ ...rule, possiblePromptInjection }));
  }
  async listRuleVersions(workspaceId: string, userId: string | null, ruleId?: string, status?: string) {
    await requireRole(this.store, workspaceId, userId, "viewer"); const ctx = this.ctx(workspaceId, userId!);
    if (status && !RULE_VERSION_STATUSES.has(status)) throw new RuleStoreError("INVALID_RULE_VERSION", 422);
    const filter = { ...(ruleId ? { ruleId } : {}), ...(status ? { status } : {}) };
    const [versions, jobs] = await Promise.all([this.store.list(ctx, "rule_versions", filter), this.store.list(ctx, "analysis_jobs", { type: "proposal" })]);
    const warnedFindingIds = [...new Set(jobs.filter(job => Array.isArray(job.warnings) && job.warnings.some(w => (w as DocumentData).code === "possible_prompt_injection")).map(job => (job.payload as DocumentData | undefined)?.driftFindingId).filter((id): id is string => typeof id === "string"))];
    const findings = (await Promise.all(warnedFindingIds.map((id) => this.store.get(ctx, "drift_findings", id)))).filter((finding): finding is DocumentData => finding !== null);
    const warnedVersions = new Set(findings.map(finding => finding.proposalVersionId));
    return versions.map(version => ({ ...version, possiblePromptInjection: warnedVersions.has(version.id) }));
  }
  async getPublicationState(workspaceId: string, userId: string | null, ruleVersionId: string) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.getPublicationState(this.ctx(workspaceId, userId!), ruleVersionId); }
  async getPublicationStates(workspaceId: string, userId: string | null, ruleVersionIds: readonly string[]) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.getPublicationStates(this.ctx(workspaceId, userId!), ruleVersionIds); }
  async createRelation(workspaceId: string, userId: string | null, input: CreateRuleRelationInput): Promise<DocumentData> {
    const role = await requireRole(this.store, workspaceId, userId, "member");
    const ctx = this.ctx(workspaceId, userId!), kind = await this.workspaceKind(workspaceId);
    const [parent, child] = await Promise.all([
      this.store.get(ctx, "rules", input.parentRuleId), this.store.get(ctx, "rules", input.childRuleId),
    ]);
    if (!parent || !child) throw new RuleStoreError("NOT_FOUND", 404);
    // A relation can remove an approved organization policy without touching its version.
    // Both participating rules therefore require their respective approval authorities.
    for (const rule of [parent, child]) {
      if (!canApproveRuleVersion({ workspaceKind: kind, enforcement: rule.enforcement as never, scopeType: rule.scopeType as never }, role)) {
        throw new RuleStoreError("FORBIDDEN", 403, { operation: "createRuleRelation" });
      }
    }
    return this.store.createRelation(ctx, input);
  }
  async listRelations(workspaceId: string, userId: string | null): Promise<DocumentData[]> { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "rule_relations"); }
}
