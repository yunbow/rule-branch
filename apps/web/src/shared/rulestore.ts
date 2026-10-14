/** Firestore RuleStore foundation. Domain operations deliberately belong to later IMPL tickets. */
import { createHash } from "node:crypto";
import type { Firestore as AdminFirestore } from "firebase-admin/firestore";
import { LIMITS } from "./contracts.ts";
import { generateUlid } from "./ulid.ts";
import { auditActor } from "./service-context.ts";
import { uncoveredRelationFields } from "./relation-scope.ts";

export interface RuleStoreContext { workspaceId: string; actorUserId: string | null; actorKind?: "user" | "ai" | "system" | "github"; }
export type DocumentData = Record<string, unknown>;
export function projectIdForRule(rule: DocumentData): string | null { if (rule.scopeType !== "project") return null; return typeof rule.projectId === "string" && rule.projectId ? rule.projectId : typeof rule.scopeId === "string" && rule.scopeId ? rule.scopeId : null; }
/** Match the same repository scope used for rule-version approval. Include the
 * previously selected repositories before a selector or status mutation. */
export function repositoryTargetsForRule(rule: DocumentData, repositories: readonly DocumentData[]): string[] {
  if (!["active", "stale"].includes(String(rule.status))) return [];
  const projectId = projectIdForRule(rule);
  if (rule.scopeType !== "organization" && !projectId) return [];
  const selected = (rule.selector as DocumentData | undefined)?.repositoryIds;
  return repositories.filter((repository) =>
    repository.status === "active" && !repository.deletedAt &&
    repository.ownerWorkspaceId === rule.ownerWorkspaceId &&
    (rule.scopeType === "organization" || repository.projectId === projectId) &&
    (!Array.isArray(selected) || selected.length === 0 || selected.includes(repository.id))
  ).map((repository) => String(repository.id));
}
/** Persist a new generation with the pending union in the caller's mutation transaction. */
export function pendingRuleCompilationPatch(rule: DocumentData, repositoryIds: readonly string[]): DocumentData {
  const existing = Array.isArray(rule.pendingCompileRepositoryIds)
    ? rule.pendingCompileRepositoryIds.filter((value): value is string => typeof value === "string") : [];
  const combined = [...new Set([...existing, ...repositoryIds])];
  return combined.length ? { compilePending: true, compileRevisionId: generateUlid(), pendingCompileRepositoryIds: combined } : {};
}
export interface DocumentSnapshotLike { exists: boolean; id: string; data(): DocumentData | undefined; }
export interface DocumentReferenceLike { id: string; get(): Promise<DocumentSnapshotLike>; }
export type QueryOperator = "==" | "array-contains";
export type QueryDirection = "asc" | "desc";
export interface QueryConstraint { field: string; op: QueryOperator; value: unknown; }
export interface ListQueryOptions { orderBy?: { field: string; direction?: QueryDirection }; limit?: number; startAfter?: unknown; }
export interface QueryLike { where(field: string, op: QueryOperator, value: unknown): QueryLike; orderBy(field: string, direction?: QueryDirection): QueryLike; limit(value: number): QueryLike; startAfter(value: unknown): QueryLike; get(): Promise<{ docs: DocumentSnapshotLike[] }>; }
export interface TransactionLike { get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike>; getQuery(query: QueryLike): Promise<{ docs: DocumentSnapshotLike[] }>; create(ref: DocumentReferenceLike, data: DocumentData): unknown; update(ref: DocumentReferenceLike, data: DocumentData): unknown; delete(ref: DocumentReferenceLike): unknown; }
export interface FirestoreLike { collection(name: string): { doc(id: string): DocumentReferenceLike; where(field: string, op: QueryOperator, value: unknown): QueryLike }; getAll?(...refs: DocumentReferenceLike[]): Promise<DocumentSnapshotLike[]>; runTransaction<T>(fn: (transaction: TransactionLike) => Promise<T>): Promise<T>; }

export const UNIQUE_KEY_KINDS = ["github_user", "user_preference", "github_org", "github_installation", "github_repo", "workspace_member", "workspace_invitation_pending", "project_slug", "rule_key", "rule_relation_child", "revision_pr_open", "job_idempotency"] as const;
export type UniqueKeyKind = (typeof UNIQUE_KEY_KINDS)[number];
export interface UniqueTarget { targetTable: string; targetId: string; }
export interface AuditEntry { actor: { kind: "user" | "ai" | "system" | "github"; id: string }; action: string; targetType: string; targetId: string; requestId: string; before?: unknown; after?: unknown; ip?: string | null; occurredAt?: string; }

// Kept in camelCase to make the Worker/API contract mechanically comparable (DM 10.3).
export const RULE_STORE_METHOD_SIGNATURES = Object.freeze([
  ["get", "ctx,collection,id"], ["list", "ctx,collection,filter"], ["reserveUniqueKey", "tx,kind,components,target"], ["releaseUniqueKey", "tx,kind,components"], ["runTransaction", "callback"],
  ["appendAuditLog", "ctx,entry,tx"], ["redactAuditLogPayloads", "ctx,filter"],
  ["linkRepository", "ctx,input"], ["getRule", "ctx,ruleId"], ["listRules", "ctx,filter"], ["createRule", "ctx,input"], ["updateRuleStatus", "ctx,ruleId,status,opts"],
  ["createRuleVersion", "ctx,ruleId,input"], ["approveRuleVersion", "ctx,ruleVersionId,approvedBy"], ["rejectRuleVersion", "ctx,ruleVersionId,reason"], ["withdrawRuleVersion", "ctx,ruleVersionId,opts"], ["listRuleVersions", "ctx,ruleId"], ["getPublicationState", "ctx,ruleVersionId"],
  ["createRelation", "ctx,input"], ["resolveRules", "ctx,projectId,repositoryId,userId,selector"], ["recordProvenance", "ctx,entries"], ["createDriftFinding", "ctx,input"], ["updateDriftFinding", "ctx,driftFindingId,patch"], ["createTrigger", "ctx,input"], ["listImpact", "ctx,ruleVersionId"],
  ["listMembers", "ctx,workspaceId"], ["addMember", "ctx,input"], ["updateMemberRole", "ctx,memberId,role"], ["removeMember", "ctx,memberId"], ["createInvitation", "ctx,input"], ["listInvitations", "ctx,filter"], ["updateInvitationStatus", "ctx,invitationId,status,actorUserId"],
  ["purgeWorkspace", "ctx,workspaceId,preserveJobId"], ["createAnalysisJob", "ctx,input"], ["updateAnalysisJobStatus", "ctx,jobId,status,opts"], ["createBootstrapBatch", "ctx,projectId,candidates"], ["createDriftScanBatch", "ctx,triggerId,findings"], ["openRevisionPr", "ctx,input"], ["updateRevisionPrStatus", "ctx,revisionPrId,status,opts"], ["recordPublishVerification", "ctx,revisionPrId,result"],
] as const);

export interface LinkRepositoryInput { projectId: string; installationId: string; githubRepoId: string; fullName: string; githubOwnerLogin: string; defaultBranch: string; requestId: string; }
export interface CreateRuleVersionInput { content: string; rationale: string; evidenceIds?: string[]; compatibility?: DocumentData; changeType: string; provenance?: DocumentData; supersedes?: string | null; driftFindingIds?: string[]; triggerId?: string | null; aiSummary?: string | null; requestId?: string; }
export interface CreateRuleRelationInput { childRuleId: string; parentRuleId: string; relationType: "override" | "extend" | "deny" | string; rationale?: string | null; requestId?: string; }
export interface RuleSelector { languages?: string[]; frameworks?: string[]; directoryGlobs?: string[]; dependencies?: string[]; repositoryIds?: string[]; }
export interface ResolutionSnapshot extends DocumentData { id: string; ruleVersionIds: string[]; conflicts: DocumentData[]; resolverVersion: string; presentation?: DocumentData[]; }
export interface RuleVersionActionOptions { requestId?: string; comment?: string; /** Internal-only: status restoration and approval share one transaction. */ restoreArchived?: boolean; }
export interface RuleStatusOptions { rationale?: string; supersededByRuleId?: string; requestId?: string; approvedVersionId?: string; }
export interface RuleStore { get(ctx: RuleStoreContext, collection: string, id: string): Promise<DocumentData | null>; list(ctx: RuleStoreContext, collection: string, filter?: Record<string, unknown>): Promise<DocumentData[]>; reserveUniqueKey(tx: TransactionLike, kind: UniqueKeyKind, components: Record<string, string>, target: UniqueTarget): Promise<void>; releaseUniqueKey(tx: TransactionLike, kind: UniqueKeyKind, components: Record<string, string>): Promise<void>; runTransaction<T>(callback: (tx: TransactionLike) => Promise<T>): Promise<T>; appendAuditLog(ctx: RuleStoreContext, entry: AuditEntry, tx?: TransactionLike): Promise<void>; redactAuditLogPayloads(ctx: RuleStoreContext, filter: { before: string } | { workspaceId: string }): Promise<{ count: number }>; linkRepository(ctx: RuleStoreContext, input: LinkRepositoryInput, tx?: TransactionLike): Promise<DocumentData>; createAnalysisJob(ctx: RuleStoreContext, input: CreateAnalysisJobInput): Promise<{ job: AnalysisJob; created: boolean }>; updateAnalysisJobStatus(ctx: RuleStoreContext, jobId: string, status: AnalysisJobStatus, opts?: { error?: string; warnings?: JobWarning[]; maxAttempts?: number; requestId?: string }): Promise<AnalysisJob>; }

export const ANALYSIS_JOB_TYPES = ["bootstrap", "pr_review", "drift_scan", "proposal", "compile", "impact", "purge", "publish_verify"] as const;
export type AnalysisJobType = (typeof ANALYSIS_JOB_TYPES)[number];
export type AnalysisJobStatus = "queued" | "running" | "done" | "failed" | "dead";
export interface JobWarning { code: "possible_prompt_injection" | "evidence_unverifiable" | "output_truncated" | "schema_retry" | "duplicate_rule_key"; message: string; path?: string; line?: number; }
export interface CreateAnalysisJobInput { type: AnalysisJobType; projectId?: string | null; payload: DocumentData; idempotencyKey: string; requestId?: string; }
export interface AnalysisJob extends DocumentData { id: string; ownerWorkspaceId: string; type: AnalysisJobType; status: AnalysisJobStatus; attempts: number; idempotencyKey: string; }

const RULE_STORE_ERROR_BRAND = Symbol.for("rulebranch.RuleStoreError");
export class RuleStoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: string, status: number, details: Record<string, unknown> = {}) {
    super(code);
    Object.defineProperty(this, RULE_STORE_ERROR_BRAND, { value: true });
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
/** Reject an exception that would remove parent policy outside the child scope. */
export function assertRelationScopeCoverage(parent: DocumentData, child: DocumentData, relationType: string): void {
  if (relationType !== "override" && relationType !== "deny") return;
  let fields: string[];
  try { fields = uncoveredRelationFields(parent.selector, child.selector); }
  catch { throw new RuleStoreError("INVALID_SELECTOR", 422); }
  if (fields.length) throw new RuleStoreError("CONDITIONAL_RELATION_UNSUPPORTED", 422, {
    parentRuleId: parent.id, childRuleId: child.id, relationType, fields,
  });
}
/** Recognizes trusted RuleStore errors even when a production bundle contains another copy of the class. */
export function isRuleStoreError(error: unknown): error is RuleStoreError {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
  try {
    const branded = Object.getOwnPropertyDescriptor(error, RULE_STORE_ERROR_BRAND);
    const code = Object.getOwnPropertyDescriptor(error, "code");
    const status = Object.getOwnPropertyDescriptor(error, "status");
    const details = Object.getOwnPropertyDescriptor(error, "details");
    const message = Object.getOwnPropertyDescriptor(error, "message");
    const statusValue = status?.value;
    if (branded?.value !== true || typeof code?.value !== "string" || !code.value ||
        !Number.isInteger(statusValue) || typeof statusValue !== "number" || statusValue < 400 || statusValue > 599 ||
        typeof message?.value !== "string" || !details || !("value" in details)) return false;
    const value = details.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
const MAX_WRITES = ((LIMITS.limits as Record<string, unknown>).maxTransactionWrites as number);
const JOB_LIMITS = LIMITS.analysisJobs as { validStatusTransitions: Record<string, string[]>; idempotencyKeyParts: Record<AnalysisJobType, number[]>; maxIdempotencyKeyLength: number; maxPayloadBytes: number; maxWarnings: number; defaultMaxAttempts: number; };
const RULE_VERSION_LIMITS = LIMITS.ruleVersions as { maxContentBytes: number; maxRationaleBytes: number; maxAiSummaryBytes: number; maxDriftFindingIds: number; };
const MAX_EVIDENCE_PER_VERSION = (LIMITS.limits as Record<string, unknown>).maxEvidencePerVersion as number;
const REPOSITORY_LIMITS = LIMITS.repositories as { rulesPath: string; compileTargets: string[]; };
const GLOBAL_KINDS = new Set<UniqueKeyKind>(["github_user", "user_preference", "github_org", "github_installation", "github_repo"]);
const COMPONENTS: Record<UniqueKeyKind, readonly string[]> = { github_user: ["githubUserId"], user_preference: ["userId"], github_org: ["githubOrgId"], github_installation: ["githubInstallationId"], github_repo: ["githubRepoId"], workspace_member: ["workspaceId", "userId"], workspace_invitation_pending: ["workspaceId", "invitedGithubUserId"], project_slug: ["ownerWorkspaceId", "slug"], rule_key: ["ownerWorkspaceId", "scopeType", "scopeId", "key"], rule_relation_child: ["childRuleId"], revision_pr_open: ["repositoryId"], job_idempotency: ["idempotencyKeyHash"] };
export function uniqueKeyId(kind: UniqueKeyKind, components: Record<string, string>): string { const values = COMPONENTS[kind].map((name) => { const value = components[name]; if (!value || value.includes("/")) throw new Error(`Invalid ${kind} component: ${name}`); return value; }); return `${kind}:${values.join(":")}`; }
export function canonicalJson(value: unknown): string { if (value === undefined) return "null"; if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
export function sha256(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function sha256HexString(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function truncatePayload(value: unknown): unknown { if (value === undefined || value === null) return value ?? null; const encoded = Buffer.byteLength(canonicalJson(value), "utf8"); return encoded > 32 * 1024 ? { _truncated: true, sha256: sha256(value) } : value; }
export function requireHumanActor(ctx: RuleStoreContext, operation: string, status?: string): void { const protectedOperation = operation === "approveRuleVersion" || ["addMember", "updateMemberRole", "removeMember", "createInvitation", "listInvitations", "updateInvitationStatus", "listMembers", "triageDriftFinding"].includes(operation) || (operation === "updateRuleStatus" && ["deprecated", "superseded", "archived"].includes(status ?? "")); if (protectedOperation && ctx.actorUserId === null) throw new RuleStoreError("FORBIDDEN", 403, { operation }); }
export function withHumanActorGuard<T extends (ctx: RuleStoreContext, ...args: never[]) => unknown>(operation: string, fn: T): T { return ((ctx: RuleStoreContext, ...args: never[]) => { requireHumanActor(ctx, operation, operation === "updateRuleStatus" ? String(args[1]) : undefined); return fn(ctx, ...args); }) as T; }

class CountingTransaction implements TransactionLike { writes = 0; private readonly inner: TransactionLike; constructor(inner: TransactionLike) { this.inner = inner; } get(ref: DocumentReferenceLike) { return this.inner.get(ref); } getQuery(query: QueryLike) { return typeof this.inner.getQuery === "function" ? this.inner.getQuery(query) : (this.inner as unknown as { get(query: QueryLike): Promise<{ docs: DocumentSnapshotLike[] }> }).get(query); } private count(): void { this.writes += 1; if (this.writes > MAX_WRITES) throw new RuleStoreError("TRANSACTION_WRITE_LIMIT", 400, { maxTransactionWrites: MAX_WRITES }); } create(ref: DocumentReferenceLike, data: DocumentData) { this.count(); return this.inner.create(ref, data); } update(ref: DocumentReferenceLike, data: DocumentData) { this.count(); return this.inner.update(ref, data); } delete(ref: DocumentReferenceLike) { this.count(); return this.inner.delete(ref); } }

/** Production adapter: accepts a firebase-admin Firestore instance; no client is created or connected here. */
export class FirestoreRuleStore implements RuleStore {
  private readonly firestore: FirestoreLike;
  // AdminFirestore is accepted structurally; tests inject the test-only minimal double.
  constructor(firestore: FirestoreLike | AdminFirestore) { this.firestore = firestore as FirestoreLike; }
  /** Server-only document access for account-domain transactions (users and preferences).
   * Account documents are not tenant-owned, so exposing them through `get` would weaken
   * the RuleStore tenant boundary. Domain services still use runTransaction, unique keys,
   * and audit logging from this store. */
  documentRef(collection: string, id: string): DocumentReferenceLike { return this.ref(collection, id); }
  queryRef(collection: string, filter: Record<string, unknown>): QueryLike { let query: QueryLike | undefined; for (const [field, value] of Object.entries(filter)) query = (query ?? this.firestore.collection(collection)).where(field, "==", value); if (!query) throw new RuleStoreError("INVALID_QUERY", 422); return query; }
  /** Server-only account/integration lookup. It is deliberately not exposed through
   * tenant-scoped get/list; callers must use it only to establish a tenant boundary. */
  async findServerDocuments(collection: string, filter: Record<string, unknown>): Promise<DocumentData[]> {
    let query: QueryLike | undefined;
    for (const [field, value] of Object.entries(filter)) query = (query ?? this.firestore.collection(collection)).where(field, "==", value);
    return query ? (await query.get()).docs.map((doc) => doc.data()).filter((data): data is DocumentData => data !== undefined) : [];
  }
  /** Server-only batch point lookup for account and integration joins. */
  async getServerDocuments(collection: string, ids: readonly string[]): Promise<DocumentData[]> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return [];
    const snapshots: DocumentSnapshotLike[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const refs = uniqueIds.slice(offset, offset + 100).map((id) => this.ref(collection, id));
      snapshots.push(...(this.firestore.getAll ? await this.firestore.getAll(...refs) : await Promise.all(refs.map((ref) => ref.get()))));
    }
    return snapshots.map((snapshot) => snapshot.data()).filter((data): data is DocumentData => data !== undefined);
  }
  /** Tenant-scoped batch point lookup with the same visibility rules as `get`. */
  async getMany(ctx: RuleStoreContext, collection: string, ids: readonly string[]): Promise<DocumentData[]> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return [];
    const refs = uniqueIds.map((id) => this.ref(collection, id));
    const snapshots = this.firestore.getAll ? await this.firestore.getAll(...refs) : await Promise.all(refs.map((ref) => ref.get()));
    const visible = snapshots.map((snapshot) => snapshot.data()).filter((data): data is DocumentData => data !== undefined && this.visible(ctx, collection, data));
    return this.filterActiveProjectChildren(ctx, collection, visible);
  }
  async runTransaction<T>(callback: (tx: TransactionLike) => Promise<T>): Promise<T> { return this.firestore.runTransaction(async (nativeTx) => callback(new CountingTransaction(nativeTx))); }
  private ref(collection: string, id: string): DocumentReferenceLike { return this.firestore.collection(collection).doc(id); }
  /** Clear the durable bootstrap intent only after the job exists and its dispatch has succeeded. */
  async markProjectBootstrapQueued(ctx: RuleStoreContext, projectId: string): Promise<void> {
    await this.runTransaction(async (tx) => {
      const ref = this.ref("projects", projectId), snapshot = await tx.get(ref), project = snapshot.data();
      if (!snapshot.exists || !project || project.ownerWorkspaceId !== ctx.workspaceId || project.deletedAt || project.status !== "active") return;
      if (project.bootstrapPending === true) tx.update(ref, { bootstrapPending: false });
    });
  }
  async requireActiveProject(tx: TransactionLike, ctx: RuleStoreContext, projectId: string): Promise<DocumentData> {
    const snapshot = await tx.get(this.ref("projects", projectId)), project = snapshot.data();
    if (!snapshot.exists || !project || project.ownerWorkspaceId !== ctx.workspaceId || project.status !== "active" || project.deletedAt) throw new RuleStoreError("PROJECT_DELETED", 409, { projectId });
    return project;
  }
  private visible(ctx: RuleStoreContext, collection: string, data: DocumentData): boolean { const owner = data.ownerWorkspaceId; return !data.deletedAt && (owner === ctx.workspaceId || (collection === "unique_keys" && owner === null)); }
  private async filterActiveProjectChildren(ctx: RuleStoreContext, collection: string, documents: DocumentData[]): Promise<DocumentData[]> {
    if (!documents.length || collection === "projects" || collection === "unique_keys") return documents;
    const directProjectCollections = new Set(["repositories", "change_triggers", "resolution_snapshots", "compiled_artifacts", "revision_prs", "drift_findings", "analysis_jobs", "decision_memories", "evaluations", "rules", "evidence", "onboarding_questions"]);
    const projectScopeCollections = new Set(["rules", "evidence", "decision_memories", "compiled_artifacts", "onboarding_questions"]);
    const projectByDocument = new Map<string, string | null>();
    for (const document of documents) {
      const id = String(document.id);
      if (directProjectCollections.has(collection) && typeof document.projectId === "string" && document.projectId) projectByDocument.set(id, document.projectId);
      else if (projectScopeCollections.has(collection) && document.scopeType === "project" && typeof document.scopeId === "string") projectByDocument.set(id, document.scopeId);
      else if (projectScopeCollections.has(collection) && typeof document.scopeType === "string" && document.scopeType !== "project") projectByDocument.set(id, null);
    }
    const unresolved = documents.filter((document) => !projectByDocument.has(String(document.id)));
    if (collection === "rule_versions") {
      const ruleIds = unresolved.map((document) => document.ruleId).filter((id): id is string => typeof id === "string");
      const rules = new Map((await this.getServerDocuments("rules", ruleIds)).map((rule) => [String(rule.id), rule]));
      for (const document of unresolved) {
        const rule = rules.get(String(document.ruleId));
        if (!rule || rule.ownerWorkspaceId !== ctx.workspaceId || rule.deletedAt) projectByDocument.set(String(document.id), "");
        else if (typeof rule.projectId === "string") projectByDocument.set(String(document.id), rule.projectId);
        else if (rule.scopeType === "project" && typeof rule.scopeId === "string") projectByDocument.set(String(document.id), rule.scopeId);
        else projectByDocument.set(String(document.id), null);
      }
    }
    if (collection === "rule_checks") {
      // Checks belong directly to a rule; they have ruleId, not ruleVersionId.
      const ruleIds = unresolved.map((document) => document.ruleId).filter((id): id is string => typeof id === "string");
      const rules = new Map((await this.getServerDocuments("rules", ruleIds)).map((rule) => [String(rule.id), rule]));
      for (const document of unresolved) {
        const rule = rules.get(String(document.ruleId));
        if (!rule || rule.ownerWorkspaceId !== ctx.workspaceId || rule.deletedAt) projectByDocument.set(String(document.id), "");
        else projectByDocument.set(String(document.id), projectIdForRule(rule));
      }
    }
    if (collection === "usage_provenance") {
      const versionIds = unresolved.map((document) => document.ruleVersionId).filter((id): id is string => typeof id === "string");
      const versions = new Map((await this.getServerDocuments("rule_versions", versionIds)).map((version) => [String(version.id), version]));
      const ruleIds = [...versions.values()].map((version) => version.ruleId).filter((id): id is string => typeof id === "string");
      const rules = new Map((await this.getServerDocuments("rules", ruleIds)).map((rule) => [String(rule.id), rule]));
      for (const document of unresolved) {
        const version = versions.get(String(document.ruleVersionId)), rule = version && rules.get(String(version.ruleId));
        if (!version || version.ownerWorkspaceId !== ctx.workspaceId || version.deletedAt || !rule || rule.ownerWorkspaceId !== ctx.workspaceId || rule.deletedAt) projectByDocument.set(String(document.id), "");
        else if (typeof rule.projectId === "string") projectByDocument.set(String(document.id), rule.projectId);
        else if (rule.scopeType === "project" && typeof rule.scopeId === "string") projectByDocument.set(String(document.id), rule.scopeId);
        else projectByDocument.set(String(document.id), null);
      }
    }
    if (["evidence", "revision_prs", "compiled_artifacts", "resolution_snapshots", "drift_findings"].includes(collection)) {
      const repositoryIds = unresolved.map((document) => document.repositoryId).filter((id): id is string => typeof id === "string");
      const repositories = new Map((await this.getServerDocuments("repositories", repositoryIds)).map((repository) => [String(repository.id), repository]));
      for (const document of unresolved) {
        const repository = repositories.get(String(document.repositoryId));
        if (repository?.ownerWorkspaceId === ctx.workspaceId && !repository.deletedAt && typeof repository.projectId === "string") projectByDocument.set(String(document.id), repository.projectId);
        else if (typeof document.repositoryId === "string") projectByDocument.set(String(document.id), "");
      }
    }
    if (collection === "evidence") {
      const versionIds = unresolved.map((document) => document.ruleVersionId).filter((id): id is string => typeof id === "string");
      const versions = new Map((await this.getServerDocuments("rule_versions", versionIds)).map((version) => [String(version.id), version]));
      const ruleIds = [...versions.values()].map((version) => version.ruleId).filter((id): id is string => typeof id === "string");
      const rules = new Map((await this.getServerDocuments("rules", ruleIds)).map((rule) => [String(rule.id), rule]));
      for (const document of unresolved) {
        if (projectByDocument.has(String(document.id))) continue;
        const version = versions.get(String(document.ruleVersionId)), rule = version && rules.get(String(version.ruleId));
        if (!version || version.ownerWorkspaceId !== ctx.workspaceId || version.deletedAt || !rule || rule.ownerWorkspaceId !== ctx.workspaceId || rule.deletedAt) projectByDocument.set(String(document.id), "");
        else if (typeof rule.projectId === "string") projectByDocument.set(String(document.id), rule.projectId);
        else if (rule.scopeType === "project" && typeof rule.scopeId === "string") projectByDocument.set(String(document.id), rule.scopeId);
        else projectByDocument.set(String(document.id), null);
      }
    }
    if (collection === "rule_relations") {
      const ruleIds = unresolved.map((document) => document.childRuleId).filter((id): id is string => typeof id === "string");
      const rules = new Map((await this.getServerDocuments("rules", ruleIds)).map((rule) => [String(rule.id), rule]));
      for (const document of unresolved) {
        const rule = rules.get(String(document.childRuleId));
        if (!rule || rule.ownerWorkspaceId !== ctx.workspaceId || rule.deletedAt) projectByDocument.set(String(document.id), "");
        else if (typeof rule.projectId === "string") projectByDocument.set(String(document.id), rule.projectId);
        else if (rule.scopeType === "project" && typeof rule.scopeId === "string") projectByDocument.set(String(document.id), rule.scopeId);
        else projectByDocument.set(String(document.id), null);
      }
    }
    const projectIds = [...new Set([...projectByDocument.values()].filter((id): id is string => typeof id === "string" && id.length > 0))];
    const activeProjects = new Set((await this.getServerDocuments("projects", projectIds))
      .filter((project) => project.ownerWorkspaceId === ctx.workspaceId && project.status === "active" && !project.deletedAt)
      .map((project) => String(project.id)));
    return documents.filter((document) => {
      const projectId = projectByDocument.get(String(document.id));
      return projectId === undefined || projectId === null || activeProjects.has(projectId);
    });
  }
  async get(ctx: RuleStoreContext, collection: string, id: string): Promise<DocumentData | null> { const snapshot = await this.ref(collection, id).get(); const data = snapshot.data(); if (!snapshot.exists || !data || !this.visible(ctx, collection, data)) return null; return (await this.filterActiveProjectChildren(ctx, collection, [data]))[0] ?? null; }
  async list(ctx: RuleStoreContext, collection: string, filter: Record<string, unknown> = {}): Promise<DocumentData[]> { const load = async (owner: string | null) => { let query: QueryLike = this.firestore.collection(collection).where("ownerWorkspaceId", "==", owner); for (const [field, value] of Object.entries(filter)) query = query.where(field, "==", value); return (await query.get()).docs.map((doc) => doc.data()).filter((data): data is DocumentData => data !== undefined && !data.deletedAt); }; const scoped = await this.filterActiveProjectChildren(ctx, collection, await load(ctx.workspaceId)); return collection === "unique_keys" ? [...scoped, ...(await load(null))] : scoped; }
  /** Bounded tenant query for read paths where loading the whole workspace would
   * make latency and Firestore cost grow without limit. */
  async listQuery(ctx: RuleStoreContext, collection: string, constraints: readonly QueryConstraint[] = [], options: ListQueryOptions = {}): Promise<DocumentData[]> {
    if (collection === "unique_keys") throw new RuleStoreError("INVALID_QUERY", 422, { collection });
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)) throw new RuleStoreError("INVALID_QUERY_LIMIT", 422, { limit: options.limit });
    let query = this.firestore.collection(collection).where("ownerWorkspaceId", "==", ctx.workspaceId);
    for (const constraint of constraints) query = query.where(constraint.field, constraint.op, constraint.value);
    if (options.orderBy) query = query.orderBy(options.orderBy.field, options.orderBy.direction ?? "asc");
    if (options.startAfter !== undefined) {
      if (!options.orderBy) throw new RuleStoreError("INVALID_QUERY_CURSOR", 422);
      query = query.startAfter(options.startAfter);
    }
    if (options.limit !== undefined) query = query.limit(options.limit);
    const documents = (await query.get()).docs.map((doc) => doc.data()).filter((data): data is DocumentData => data !== undefined && !data.deletedAt);
    return this.filterActiveProjectChildren(ctx, collection, documents);
  }
  async reserveUniqueKey(tx: TransactionLike, kind: UniqueKeyKind, components: Record<string, string>, target: UniqueTarget): Promise<void> { const id = uniqueKeyId(kind, components); const ref = this.ref("unique_keys", id); const existing = await tx.get(ref); if (existing.exists) throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind, value: id.slice(kind.length + 1) }); const ownerWorkspaceId = GLOBAL_KINDS.has(kind) ? null : (components.ownerWorkspaceId ?? components.workspaceId); if (!GLOBAL_KINDS.has(kind) && !ownerWorkspaceId) throw new Error(`ownerWorkspaceId is required for ${kind}`); tx.create(ref, { id, kind, ownerWorkspaceId, targetTable: target.targetTable, targetId: target.targetId, createdAt: new Date().toISOString() }); }
  /** Reserves several keys without violating Firestore's read-before-write rule. */
  async reserveUniqueKeys(tx: TransactionLike, reservations: Array<{ kind: UniqueKeyKind; components: Record<string, string>; target: UniqueTarget }>): Promise<void> {
    const prepared = reservations.map((reservation) => ({ ...reservation, id: uniqueKeyId(reservation.kind, reservation.components), ownerWorkspaceId: GLOBAL_KINDS.has(reservation.kind) ? null : (reservation.components.ownerWorkspaceId ?? reservation.components.workspaceId) }));
    for (const reservation of prepared) if (!GLOBAL_KINDS.has(reservation.kind) && !reservation.ownerWorkspaceId) throw new Error(`ownerWorkspaceId is required for ${reservation.kind}`);
    const snapshots = await Promise.all(prepared.map((reservation) => tx.get(this.ref("unique_keys", reservation.id))));
    for (const [index, snapshot] of snapshots.entries()) if (snapshot.exists) { const reservation = prepared[index]!; throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind: reservation.kind, value: reservation.id.slice(reservation.kind.length + 1) }); }
    for (const reservation of prepared) tx.create(this.ref("unique_keys", reservation.id), { id: reservation.id, kind: reservation.kind, ownerWorkspaceId: reservation.ownerWorkspaceId, targetTable: reservation.target.targetTable, targetId: reservation.target.targetId, createdAt: new Date().toISOString() });
  }
  async releaseUniqueKey(tx: TransactionLike, kind: UniqueKeyKind, components: Record<string, string>): Promise<void> {
    // Firestore deletes are idempotent. Avoiding an existence read is important because
    // release commonly follows another write in the same transaction, while Firestore
    // requires every transactional read to happen before the first write.
    tx.delete(this.ref("unique_keys", uniqueKeyId(kind, components)));
  }
  async appendAuditLog(ctx: RuleStoreContext, entry: AuditEntry, tx?: TransactionLike): Promise<void> { if (!entry.requestId) throw new Error("audit requestId is required"); const before = entry.before ?? null, after = entry.after ?? null; const data: DocumentData = { id: generateUlid(), ownerWorkspaceId: ctx.workspaceId, actor: entry.actor, action: entry.action, targetType: entry.targetType, targetId: entry.targetId, before: truncatePayload(before), after: truncatePayload(after), ip: entry.ip ?? null, requestId: entry.requestId, occurredAt: entry.occurredAt ?? new Date().toISOString(), retentionClass: "audit", payloadHash: sha256({ before, after }), payloadRedactedAt: null }; const ref = this.ref("audit_logs", data.id as string); if (tx) { tx.create(ref, data); return; } await this.runTransaction(async (transaction) => { transaction.create(ref, data); }); }
  async linkRepository(ctx: RuleStoreContext, input: LinkRepositoryInput, transaction?: TransactionLike): Promise<DocumentData> {
    const link = async (tx: TransactionLike) => (await this.linkRepositories(ctx, [input], tx))[0]!;
    return transaction ? link(transaction) : this.runTransaction(link);
  }
  /** Batch form keeps every dependent read ahead of the first write. This is required
   * by Firestore and lets project creation link multiple repositories atomically. */
  async linkRepositories(ctx: RuleStoreContext, inputs: readonly LinkRepositoryInput[], tx: TransactionLike): Promise<DocumentData[]> {
    const plans = [] as Array<{ input: LinkRepositoryInput; keyRef: DocumentReferenceLike; key: DocumentSnapshotLike; current: DocumentSnapshotLike | null; previousProject: DocumentSnapshotLike | null }>;
    for (const input of inputs) {
      const installationSnapshot = await tx.get(this.ref("installations", input.installationId)), installation = installationSnapshot.data();
      if (!installationSnapshot.exists || !installation || installation.ownerWorkspaceId !== ctx.workspaceId || installation.status !== "active" || installation.repositorySelection !== "selected") throw new RuleStoreError("REPOSITORY_NOT_SELECTED", 422);
      const keyRef = this.ref("unique_keys", uniqueKeyId("github_repo", { githubRepoId: input.githubRepoId })), key = await tx.get(keyRef);
      const current = key.exists ? await tx.get(this.ref("repositories", key.data()!.targetId as string)) : null;
      const previousProject = current?.exists && current.data()?.projectId ? await tx.get(this.ref("projects", String(current.data()!.projectId))) : null;
      plans.push({ input, keyRef, key, current, previousProject });
    }
    const results: DocumentData[] = [];
    for (const { input, keyRef, key, current, previousProject } of plans) {
      const now = new Date().toISOString();
      if (key.exists) {
        const repository = current?.data();
        if (!current?.exists || !repository) throw new RuleStoreError("UNIQUE_TARGET_MISSING", 409);
        if (repository.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "github_repo" });
        if (repository.status !== "removed") throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "github_repo" });
        const previousProjectValue = previousProject?.data();
        if (previousProjectValue?.deletedAt || previousProjectValue?.status === "archived") {
          const id = generateUlid(), replacement: DocumentData = { id, ownerWorkspaceId: ctx.workspaceId, projectId: input.projectId, installationId: input.installationId, provider: "github", githubRepoId: input.githubRepoId, fullName: input.fullName, githubOwnerLogin: input.githubOwnerLogin, defaultBranch: input.defaultBranch, rulesPath: REPOSITORY_LIMITS.rulesPath, compileTargets: [...REPOSITORY_LIMITS.compileTargets], status: "active", linkedAt: now, updatedAt: now, deletedAt: null };
          tx.update(keyRef, { targetId: id }); tx.create(this.ref("repositories", id), replacement);
          await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: "repository.link", targetType: "repositories", targetId: id, requestId: input.requestId, after: { projectId: input.projectId, githubRepoId: input.githubRepoId, replacedRepositoryId: repository.id } }, tx);
          results.push(replacement); continue;
        }
        const ref = this.ref("repositories", current.id), patch: DocumentData = { projectId: input.projectId, installationId: input.installationId, provider: "github", fullName: input.fullName, githubOwnerLogin: input.githubOwnerLogin, defaultBranch: input.defaultBranch, status: "active", linkedAt: now, updatedAt: now, deletedAt: null };
        tx.update(ref, patch); const restored = { ...repository, ...patch };
        await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: "repository.link", targetType: "repositories", targetId: ref.id, requestId: input.requestId, before: { status: repository.status }, after: { status: "active", projectId: input.projectId } }, tx);
        results.push(restored); continue;
      }
      const id = generateUlid(), repository: DocumentData = { id, ownerWorkspaceId: ctx.workspaceId, projectId: input.projectId, installationId: input.installationId, provider: "github", githubRepoId: input.githubRepoId, fullName: input.fullName, githubOwnerLogin: input.githubOwnerLogin, defaultBranch: input.defaultBranch, rulesPath: REPOSITORY_LIMITS.rulesPath, compileTargets: [...REPOSITORY_LIMITS.compileTargets], status: "active", linkedAt: now, updatedAt: now, deletedAt: null };
      tx.create(keyRef, { id: keyRef.id, kind: "github_repo", ownerWorkspaceId: null, targetTable: "repositories", targetId: id, createdAt: now });
      tx.create(this.ref("repositories", id), repository);
      await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: "repository.link", targetType: "repositories", targetId: id, requestId: input.requestId, after: { projectId: input.projectId, githubRepoId: input.githubRepoId } }, tx);
      results.push(repository);
    }
    return results;
  }
  /** DM 10.5.3: the rule document is deliberately read and updated in one transaction.
   * That read/write dependency is what makes Firestore retry competing version creators. */
  async createRuleVersion(ctx: RuleStoreContext, ruleId: string, input: CreateRuleVersionInput): Promise<DocumentData> {
    validateRuleVersionInput(input);
    const linkedFindings = input.supersedes ? (await this.list(ctx, "drift_findings", { proposalVersionId: input.supersedes })).slice(0, 20) : [];
    return this.runTransaction(async (tx) => {
      const ruleRef = this.ref("rules", ruleId), ruleSnapshot = await tx.get(ruleRef), rule = ruleSnapshot.data();
      if (!ruleSnapshot.exists || !rule || rule.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      if (["superseded", "deprecated"].includes(String(rule.status))) throw new RuleStoreError("RULE_STATUS_INVALID", 422);
      let previous: DocumentData | undefined;
      if (input.supersedes) {
        const previousSnapshot = await tx.get(this.ref("rule_versions", input.supersedes)); previous = previousSnapshot.data();
        if (!previousSnapshot.exists || !previous || previous.ownerWorkspaceId !== ctx.workspaceId || previous.ruleId !== ruleId || previous.status !== "proposed") throw new RuleStoreError("SUPERSEDES_INVALID", 422);
      }
      if ((input.provenance ?? rule.provenance as DocumentData | undefined)?.sourceType === "ai" && !(input.evidenceIds ?? []).length) throw new RuleStoreError("EVIDENCE_REQUIRED", 422);
      const previousFindingIds = previous && Array.isArray(previous.driftFindingIds)
        ? previous.driftFindingIds.filter((id): id is string => typeof id === "string") : [];
      const previousFindingIdSet = new Set(previousFindingIds);
      const candidateFindingIds = [...new Set(previous
        ? [...previousFindingIds, ...linkedFindings.map((finding) => String(finding.id))]
        : (input.driftFindingIds ?? []))].slice(0, 20);
      const findingSnapshots = await Promise.all(candidateFindingIds.map((id) => tx.get(this.ref("drift_findings", id))));
      const validFindingIds = candidateFindingIds.filter((id, index) => {
        const finding = findingSnapshots[index]?.data();
        return findingSnapshots[index]?.exists && finding?.ownerWorkspaceId === ctx.workspaceId && finding.ruleId === ruleId
          && (!previous || previousFindingIdSet.has(id) || finding.proposalVersionId === previous.id);
      });
      if (!previous && validFindingIds.length !== candidateFindingIds.length) throw new RuleStoreError("NOT_FOUND", 404);
      const projectId = projectIdForRule(rule); if (projectId) await this.requireActiveProject(tx, ctx, projectId);
      const now = new Date().toISOString(), id = generateUlid(), version = Number(rule.nextVersion);
      if (!Number.isInteger(version) || version < 1) throw new RuleStoreError("INVALID_NEXT_VERSION", 409);
      const value: DocumentData = {
        id, ownerWorkspaceId: ctx.workspaceId, scopeType: rule.scopeType, scopeId: rule.scopeId, visibility: rule.visibility, enforcement: rule.enforcement,
        transferPolicy: rule.transferPolicy, licenseType: rule.licenseType, provenance: input.provenance ?? rule.provenance,
        containsPersonalData: rule.containsPersonalData ?? false, containsConfidentialData: rule.containsConfidentialData ?? false, retentionClass: rule.retentionClass ?? "standard",
        createdBy: auditActor(ctx), createdAt: now, updatedAt: now, deletedAt: null,
        ruleId, version, content: input.content, rationale: input.rationale, evidenceIds: input.evidenceIds ?? [], compatibility: input.compatibility ?? { frameworks: {}, languages: {}, tools: {} }, changeType: input.changeType,
        triggerId: previous ? previous.triggerId ?? null : input.triggerId ?? null, driftFindingIds: validFindingIds, supersedes: input.supersedes ?? null, status: "proposed", approvedBy: null, approvedAt: null, rejectionReason: null, effectiveFrom: null, effectiveTo: null, aiSummary: input.aiSummary ?? null, truncation: null,
      };
      tx.create(this.ref("rule_versions", id), value); tx.update(ruleRef, { nextVersion: version + 1, updatedAt: now });
      if (previous) {
        tx.update(this.ref("rule_versions", previous.id as string), { status: "withdrawn", updatedAt: now });
        for (const [index, findingId] of candidateFindingIds.entries()) { const findingSnapshot = findingSnapshots[index]!; if (findingSnapshot.exists && findingSnapshot.data()?.proposalVersionId === previous.id && validFindingIds.includes(findingId)) tx.update(this.ref("drift_findings", findingId), { proposalVersionId: id, updatedAt: now }); }
      }
      const actor = auditActor(ctx);
      await this.appendAuditLog(ctx, { actor, action: "rule_version.create", targetType: "rule_versions", targetId: id, requestId: input.requestId ?? `rule-version:${id}`, after: { ruleVersionId: id, version } }, tx);
      if (previous) await this.appendAuditLog(ctx, { actor, action: "rule_version.withdraw", targetType: "rule_versions", targetId: previous.id as string, requestId: input.requestId ?? `rule-version:${id}`, before: { status: "proposed" }, after: { status: "withdrawn", supersededBy: id } }, tx);
      return value;
    });
  }
  /** DM 5.12 V1–V9.  The child unique reservation makes concurrent requests safe. */
  async createRelation(ctx: RuleStoreContext, input: CreateRuleRelationInput): Promise<DocumentData> {
    if (input.childRuleId === input.parentRuleId) throw new RuleStoreError("RELATION_SELF_REFERENCE", 422);
    const repositories = await this.list(ctx, "repositories", { status: "active" });
    const relation = await this.runTransaction(async (tx) => {
      const childSnapshot = await tx.get(this.ref("rules", input.childRuleId));
      const parentSnapshot = await tx.get(this.ref("rules", input.parentRuleId));
      const child = childSnapshot.data(), parent = parentSnapshot.data();
      // V2 deliberately collapses a missing and another-tenant rule to NOT_FOUND.
      if (!childSnapshot.exists || !parentSnapshot.exists || !child || !parent || child.ownerWorkspaceId !== ctx.workspaceId || parent.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      if (parent.scopeType !== "organization" || child.scopeType !== "project" || parent.scopeId !== child.ownerWorkspaceId) throw new RuleStoreError("RELATION_SCOPE_INVALID", 422);
      if (!["draft", "active", "stale"].includes(String(parent.status)) || !["draft", "active", "stale"].includes(String(child.status))) throw new RuleStoreError("RELATION_RULE_STATUS_INVALID", 422);
      if (!["override", "extend", "deny"].includes(input.relationType)) throw new RuleStoreError("RELATION_TYPE_INVALID", 422);
      if (["override", "deny"].includes(input.relationType) && !["default", "advisory"].includes(String(parent.enforcement))) throw new RuleStoreError("RELATION_ENFORCEMENT_INVALID", 422);
      if (input.relationType === "deny" && (typeof input.rationale !== "string" || input.rationale.trim().length < 1 || input.rationale.length > 2000)) throw new RuleStoreError("RELATION_RATIONALE_REQUIRED", 422);
      if (child.enforcement === "personal" || parent.enforcement === "personal") throw new RuleStoreError("RELATION_ENFORCEMENT_INVALID", 422);
      assertRelationScopeCoverage(parent, child, input.relationType);
      const projectId = projectIdForRule(child); if (projectId) await this.requireActiveProject(tx, ctx, projectId);
      const id = generateUlid(), now = new Date().toISOString();
      await this.reserveUniqueKey(tx, "rule_relation_child", { childRuleId: input.childRuleId, ownerWorkspaceId: ctx.workspaceId }, { targetTable: "rule_relations", targetId: id });
      const relation: DocumentData = { id, ownerWorkspaceId: ctx.workspaceId, childRuleId: input.childRuleId, parentRuleId: input.parentRuleId, relationType: input.relationType, rationale: input.relationType === "deny" ? input.rationale!.trim() : null, validationStatus: "unchecked", createdBy: auditActor(ctx), createdAt: now };
      tx.create(this.ref("rule_relations", id), relation);
      // Relation changes can remove an approved organization policy. Queue a
      // compilation for the affected child's repositories in the same commit.
      const targets = repositoryTargetsForRule(child, repositories);
      const compilePatch = targets.length && ["active", "stale"].includes(String(parent.status))
        ? pendingRuleCompilationPatch(child, targets) : {};
      // Write both read parents as transaction fences. A concurrent selector
      // edit must retry relation creation against the new selector.
      tx.update(this.ref("rules", String(parent.id)), { updatedAt: now });
      tx.update(this.ref("rules", String(child.id)), { updatedAt: now, ...compilePatch });
      await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: "relation.create", targetType: "rule_relations", targetId: id, requestId: input.requestId ?? `relation:${id}`, after: { childRuleId: input.childRuleId, parentRuleId: input.parentRuleId, relationType: input.relationType } }, tx);
      return relation;
    });
    // Immediate dispatch is best-effort; the persisted intent is reconciled by Scheduler.
    await this.flushRuleCompilations(ctx, input.childRuleId).catch(() => {});
    return relation;
  }
  /** K2: implemented only by the Python Worker. STRETCH-06 may add the Web preview implementation. */
  async resolveRules(_ctx: RuleStoreContext, _projectId: string, _repositoryId: string, _userId?: string, _selector?: RuleSelector): Promise<ResolutionSnapshot> { throw new Error("resolveRules is implemented by the Python Worker (K2)"); }
  /** Dispatches the durable compile intent written by the approval transaction. */
  async onRuleVersionApproved(ruleVersionId: string, context?: RuleStoreContext): Promise<void> {
    if (!context) return;
    const version = await this.get(context, "rule_versions", ruleVersionId); if (!version) return;
    if (version.compilePending === true) { await this.flushRuleVersionCompilations(context, ruleVersionId); return; }
    // Compatibility for callers that use this hook with an already-approved/legacy
    // version that predates the durable compile intent fields.
    const rule = await this.get(context, "rules", version.ruleId as string); if (!rule) return;
    let repositories = (await this.list(context, "repositories")).filter((repository) => repository.status === "active");
    if (rule.scopeType === "project") repositories = repositories.filter((repository) => repository.projectId === rule.projectId);
    const selected = (rule.selector as DocumentData | undefined)?.repositoryIds;
    if (Array.isArray(selected) && selected.length) repositories = repositories.filter((repository) => selected.includes(repository.id));
    await Promise.all(repositories.map((repository) => this.createAnalysisJob(context, { type: "compile", projectId: repository.projectId as string, payload: { repositoryId: repository.id, ruleVersionId }, idempotencyKey: `compile:${repository.id}:${ruleVersionId}`, requestId: `rule-version-approve:${ruleVersionId}` })));
  }
  private async flushRuleVersionCompilations(ctx: RuleStoreContext, ruleVersionId: string): Promise<boolean> {
    const version = await this.get(ctx, "rule_versions", ruleVersionId); if (!version || version.compilePending !== true || !Array.isArray(version.pendingCompileRepositoryIds)) return false;
    let complete = true;
    for (const repositoryId of version.pendingCompileRepositoryIds) try {
      const repository = await this.get(ctx, "repositories", String(repositoryId));
      if (!repository || repository.status !== "active" || typeof repository.projectId !== "string") continue;
      await this.createAnalysisJob({ ...ctx, actorKind: ctx.actorKind ?? "system" }, { type: "compile", projectId: repository.projectId, payload: { repositoryId, ruleVersionId }, idempotencyKey: `compile:${repositoryId}:${ruleVersionId}`, requestId: `rule-version-approve:${ruleVersionId}` });
    } catch { complete = false; }
    if (complete) await this.runTransaction(async (tx) => { const ref = this.ref("rule_versions", ruleVersionId), current = await tx.get(ref); if (current.exists && current.data()?.ownerWorkspaceId === ctx.workspaceId && current.data()?.compilePending === true) tx.update(ref, { compilePending: false }); });
    return complete;
  }
  /** Reconcile rule edits even if the request died after committing the DB update.
   * Compilation reads the latest rule set and therefore safely covers superseded intents. */
  async flushRuleCompilations(ctx: RuleStoreContext, ruleId: string): Promise<boolean> {
    const snapshot = await this.ref("rules", ruleId).get(), rule = snapshot.data();
    if (!snapshot.exists || !rule || rule.ownerWorkspaceId !== ctx.workspaceId ||
        rule.compilePending !== true || !Array.isArray(rule.pendingCompileRepositoryIds) ||
        typeof rule.compileRevisionId !== "string") return false;
    const generation = rule.compileRevisionId;
    let complete = true;
    for (const repositoryId of rule.pendingCompileRepositoryIds) {
      try {
        if (typeof repositoryId !== "string") { complete = false; continue; }
        const repository = await this.get(ctx, "repositories", repositoryId);
        if (!repository || repository.status !== "active" || typeof repository.projectId !== "string") continue;
        const project = await this.get(ctx, "projects", repository.projectId);
        if (!project || project.status !== "active") continue;
        await this.createAnalysisJob({ ...ctx, actorKind: ctx.actorKind ?? "system" }, {
          type: "compile", projectId: repository.projectId, payload: { repositoryId },
          idempotencyKey: `compile:${repositoryId}:${generation}`,
          requestId: `rule-publish:${ruleId}:${generation}`,
        });
      } catch { complete = false; }
    }
    if (!complete) return false;
    return this.runTransaction(async (tx) => {
      const ref = this.ref("rules", ruleId), current = await tx.get(ref);
      if (!current.exists || current.data()?.ownerWorkspaceId !== ctx.workspaceId ||
          current.data()?.compilePending !== true || current.data()?.compileRevisionId !== generation) return false;
      tx.update(ref, { compilePending: false, pendingCompileRepositoryIds: [] });
      return true;
    });
  }
  async reconcilePendingCompilations(): Promise<number> {
    const pending = await this.findServerDocuments("rule_versions", { compilePending: true }); let completed = 0;
    for (const version of pending) if (typeof version.id === "string" && typeof version.ownerWorkspaceId === "string" && await this.flushRuleVersionCompilations({ workspaceId: version.ownerWorkspaceId, actorUserId: null, actorKind: "system" }, version.id)) completed += 1;
    const editedRules = await this.findServerDocuments("rules", { compilePending: true });
    for (const rule of editedRules) if (typeof rule.id === "string" && typeof rule.ownerWorkspaceId === "string" && await this.flushRuleCompilations({ workspaceId: rule.ownerWorkspaceId, actorUserId: null, actorKind: "system" }, rule.id)) completed += 1;
    return completed;
  }
  /** DM 8.4.  This intentionally uses resolution snapshots, never revisionPr.ruleVersionIds. */
  async getPublicationState(ctx: RuleStoreContext, ruleVersionId: string): Promise<DocumentData> {
    return (await this.getPublicationStates(ctx, [ruleVersionId]))[ruleVersionId]!;
  }
  /** Batch form used by rule lists. Shared collections are read once rather than once per row. */
  async getPublicationStates(ctx: RuleStoreContext, ruleVersionIds: readonly string[]): Promise<Record<string, DocumentData>> {
    const ids = [...new Set(ruleVersionIds)];
    if (!ids.length) return {};
    const versionDocuments = await this.getMany(ctx, "rule_versions", ids);
    const versionsById = new Map(versionDocuments.map((version) => [version.id as string, version]));
    const versions = ids.map((id) => versionsById.get(id));
    if (versions.some((version) => !version)) throw new RuleStoreError("NOT_FOUND", 404);
    const ruleIds = [...new Set(versions.map((version) => version!.ruleId as string))];
    const [ruleDocuments, repositories, openPrs, mergedPrs] = await Promise.all([
      this.getMany(ctx, "rules", ruleIds),
      this.list(ctx, "repositories", { status: "active" }),
      this.list(ctx, "revision_prs", { status: "draft_open" }),
      this.list(ctx, "revision_prs", { status: "merged" }),
    ]);
    const rulesById = new Map(ruleDocuments.map((rule) => [rule.id as string, rule]));
    const rules = ruleIds.map((id) => rulesById.get(id));
    if (rules.some((rule) => !rule)) throw new RuleStoreError("NOT_FOUND", 404);
    const latestMergedByRepository = new Map<string, DocumentData>(), openByRepository = new Map<string, DocumentData>();
    for (const pr of [...openPrs, ...mergedPrs]) {
      const repositoryId = pr.repositoryId as string;
      if (pr.status === "draft_open" && !openByRepository.has(repositoryId)) openByRepository.set(repositoryId, pr);
      if (pr.status === "merged") {
        const previous = latestMergedByRepository.get(repositoryId);
        if (!previous || String(pr.mergedAt).localeCompare(String(previous.mergedAt)) > 0) latestMergedByRepository.set(repositoryId, pr);
      }
    }
    const snapshotIds = [...new Set([...latestMergedByRepository.values(), ...openByRepository.values()]
      .map((pr) => pr.resolutionSnapshotId).filter((id): id is string => typeof id === "string"))];
    const snapshots = await this.getMany(ctx, "resolution_snapshots", snapshotIds);
    const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id as string, new Set(Array.isArray(snapshot.ruleVersionIds) ? snapshot.ruleVersionIds : [])]));
    const activeRepositories = repositories;
    return Object.fromEntries(versions.map((version) => {
      const ruleVersionId = version!.id as string, rule = rulesById.get(version!.ruleId as string)!;
      let targets = activeRepositories;
      if (rule.scopeType === "project") {
        targets = targets.filter((repository) => repository.projectId === rule.projectId);
        const selected = (rule.selector as DocumentData | undefined)?.repositoryIds;
        if (Array.isArray(selected) && selected.length) targets = targets.filter((repository) => selected.includes(repository.id));
      }
      const perRepository = targets.map((repository) => {
        const latestMerged = latestMergedByRepository.get(repository.id as string), latestOpen = openByRepository.get(repository.id as string);
      let state = "not_published";
      if (latestMerged && (latestMerged.verification as DocumentData | undefined)?.state === "verified") {
          if (snapshotsById.get(latestMerged.resolutionSnapshotId as string)?.has(ruleVersionId)) state = "published";
      }
        if (state === "not_published" && latestOpen && snapshotsById.get(latestOpen.resolutionSnapshotId as string)?.has(ruleVersionId)) state = "pr_open";
      const verification = latestMerged?.verification as DocumentData | undefined;
      return { repositoryId: repository.id, state, prUrl: state === "pr_open" ? latestOpen?.prUrl ?? null : null, commitSha: state === "published" ? verification?.checkedCommitSha ?? null : null, verification: latestMerged ? verification?.state ?? null : null };
      });
      const n = targets.length, p = perRepository.filter((item) => item.state === "published").length, o = perRepository.filter((item) => item.state === "pr_open").length;
      const aggregate = n === 0 ? "not_published" : p === n ? "published" : p > 0 && p < n ? "partially_published" : p === 0 && o > 0 ? "pr_open" : "not_published";
      return [ruleVersionId, { aggregate, perRepository }];
    }));
  }
  /** T5. Findings are supplied by the caller so this works with the minimal transaction API. */
  async recomputeRuleStaleness(tx: TransactionLike, ruleId: string, findings: readonly DocumentData[]): Promise<DocumentData> {
    const ref = this.ref("rules", ruleId), snapshot = await tx.get(ref), rule = snapshot.data();
    if (!snapshot.exists || !rule) throw new RuleStoreError("NOT_FOUND", 404);
    if (["open", "accepted"].some((status) => findings.some((finding) => finding.status === status))) return rule;
    if (rule.status !== "stale") return rule;
    const patch = { status: "active", staleSince: null, updatedAt: new Date().toISOString() };
    tx.update(ref, patch); return { ...rule, ...patch };
  }
  /** T4 threshold helper, intentionally independent from finding creation/triage APIs. */
  applyStaleIfThreshold(tx: TransactionLike, rule: DocumentData, finding: DocumentData): DocumentData {
    const threshold = (LIMITS.drift as { staleThreshold: { minimumSeverity: string; minimumConfidence: number } }).staleThreshold;
    const severity = ["info", "low", "medium", "high"];
    if (severity.indexOf(String(finding.severity)) < severity.indexOf(threshold.minimumSeverity) || Number(finding.confidence) < threshold.minimumConfidence || !["active", "stale"].includes(String(rule.status))) return rule;
    const now = new Date().toISOString(), patch = { status: "stale", staleSince: rule.staleSince ?? now, updatedAt: now };
    tx.update(this.ref("rules", rule.id as string), patch); return { ...rule, ...patch };
  }
  async approveRuleVersion(ctx: RuleStoreContext, ruleVersionId: string, options: RuleVersionActionOptions = {}): Promise<DocumentData> {
    requireHumanActor(ctx, "approveRuleVersion");
    const candidate = await this.get(ctx, "rule_versions", ruleVersionId);
    if (!candidate) throw new RuleStoreError("NOT_FOUND", 404);
    const repositoryCandidates = (await this.list(ctx, "repositories")).filter((repository) => repository.status === "active");
    const findings = await this.list(ctx, "drift_findings", { ruleId: candidate.ruleId });
    const result = await this.runTransaction(async (tx) => {
      const versionRef = this.ref("rule_versions", ruleVersionId), versionSnapshot = await tx.get(versionRef), version = versionSnapshot.data();
      const ruleRef = this.ref("rules", candidate.ruleId as string), ruleSnapshot = await tx.get(ruleRef), rule = ruleSnapshot.data();
      if (!versionSnapshot.exists || !version || !ruleSnapshot.exists || !rule || version.ownerWorkspaceId !== ctx.workspaceId || rule.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404);
      if (version.status !== "proposed") throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from: version.status, to: "approved" });
      // Check the fresh parent in the approval transaction, before any writes.
      // Deprecation/supersession must not let an outstanding proposal advance
      // currentVersionId, supersede the old version or enqueue publication.
      const allowedRuleStatuses = options.restoreArchived ? ["archived"] : ["draft", "active", "stale"];
      if (!allowedRuleStatuses.includes(String(rule.status))) {
        throw new RuleStoreError("RULE_STATUS_INVALID", 422);
      }
      const now = new Date().toISOString(), actor = auditActor(ctx);
      const oldId = typeof rule.currentVersionId === "string" && rule.currentVersionId !== ruleVersionId ? rule.currentVersionId : null;
      const oldSnapshot = oldId ? await tx.get(this.ref("rule_versions", oldId)) : null;
      const old = oldSnapshot?.exists && oldSnapshot.data()?.status === "approved" ? oldSnapshot.data()! : null;
      const findingIds = new Set(Array.isArray(version.driftFindingIds) ? version.driftFindingIds : []);
      const targetFindings = findings.filter((finding) => findingIds.has(finding.id));
      const targetSnapshots = await Promise.all(targetFindings.map((finding) => tx.get(this.ref("drift_findings", finding.id as string))));
      const projectId = projectIdForRule(rule); if (projectId) await this.requireActiveProject(tx, ctx, projectId);
      let compileTargets = repositoryCandidates;
      if (rule.scopeType === "project") compileTargets = compileTargets.filter((repository) => repository.projectId === rule.projectId);
      const selected = (rule.selector as DocumentData | undefined)?.repositoryIds;
      if (Array.isArray(selected) && selected.length) compileTargets = compileTargets.filter((repository) => selected.includes(repository.id));
      const versionPatch = { status: "approved", approvedBy: ctx.actorUserId, approvedAt: now, effectiveFrom: now, updatedAt: now, compilePending: compileTargets.length > 0, pendingCompileRepositoryIds: compileTargets.map((repository) => repository.id) };
      const resolvedIds = new Set(targetSnapshots.filter((snapshot) => snapshot.exists && snapshot.data()?.ownerWorkspaceId === ctx.workspaceId).map((snapshot) => snapshot.id));
      const postResolution = findings.map((finding) => resolvedIds.has(finding.id as string) ? { ...finding, status: "resolved" } : finding);
      const clearsStale = rule.status === "stale" && !postResolution.some((finding) => ["open", "accepted"].includes(String(finding.status)));
      const rulePatch: DocumentData = { currentVersionId: ruleVersionId, updatedAt: now, ...(options.restoreArchived || rule.status === "draft" || clearsStale ? { status: "active", staleSince: null } : {}) };
      if (old) tx.update(this.ref("rule_versions", old.id as string), { status: "superseded", effectiveTo: now, updatedAt: now });
      tx.update(versionRef, versionPatch); tx.update(ruleRef, rulePatch);
      for (const [index, finding] of targetFindings.entries()) {
        const findingSnapshot = targetSnapshots[index]!;
        if (findingSnapshot.exists && findingSnapshot.data()?.ownerWorkspaceId === ctx.workspaceId) tx.update(this.ref("drift_findings", finding.id as string), { status: "resolved", resolvedByRuleVersionId: ruleVersionId, resolvedAt: now, updatedAt: now });
      }
      const updatedRule = { ...rule, ...rulePatch };
      const memoryId = generateUlid(), oldVersion = old;
      const memory: DocumentData = { id: memoryId, ownerWorkspaceId: ctx.workspaceId, scopeType: rule.scopeType, scopeId: rule.scopeId, visibility: rule.visibility, enforcement: rule.enforcement, transferPolicy: rule.transferPolicy, licenseType: rule.licenseType, provenance: rule.provenance, containsPersonalData: rule.containsPersonalData ?? false, containsConfidentialData: rule.containsConfidentialData ?? false, retentionClass: rule.retentionClass ?? "standard", createdBy: actor, createdAt: now, updatedAt: now, deletedAt: null, projectId: rule.projectId ?? null, title: `${rule.title} v${version.version}`, context: oldVersion?.aiSummary ?? oldVersion?.rationale ?? "初回承認", decision: version.rationale, consequences: `${String(version.changeType)} の承認${options.comment ? `: ${options.comment}` : ""}`, linkedRuleIds: [rule.id], linkedEvidenceIds: (version.evidenceIds as unknown[] ?? []).slice(0, MAX_EVIDENCE_PER_VERSION), approvedRuleVersionId: ruleVersionId, approvedRuleVersionNumber: typeof version.version === "number" ? version.version : null, approvedChangeType: typeof version.changeType === "string" ? version.changeType : null, approvalComment: typeof options.comment === "string" ? options.comment : null, approvalMode: "human", sourceType: "approval", status: "active" };
      tx.create(this.ref("decision_memories", memoryId), memory);
      if (options.restoreArchived) {
        await this.appendAuditLog(ctx, { actor, action: "rule.status_change", targetType: "rules", targetId: String(rule.id),
          requestId: options.requestId ?? `rule-restore:${rule.id}`, before: rule, after: { ...rule, ...rulePatch } }, tx);
      }
      await this.appendAuditLog(ctx, { actor, action: "rule_version.approve", targetType: "rule_versions", targetId: ruleVersionId, requestId: options.requestId ?? `rule-version-approve:${ruleVersionId}`, before: version, after: { ...version, ...versionPatch, rule: { ...rule, ...rulePatch, ...updatedRule } } }, tx);
      return { ...version, ...versionPatch };
    });
    await this.onRuleVersionApproved(ruleVersionId, ctx); return result;
  }
  private async closeProposal(ctx: RuleStoreContext, ruleVersionId: string, status: "rejected" | "withdrawn", reason?: string, requestId?: string): Promise<DocumentData> {
    if (status === "rejected" && !reason?.trim()) throw new RuleStoreError("REJECTION_REASON_REQUIRED", 422);
    const version = await this.get(ctx, "rule_versions", ruleVersionId); if (!version) throw new RuleStoreError("NOT_FOUND", 404);
    const findings = (await this.list(ctx, "drift_findings", { proposalVersionId: ruleVersionId })).slice(0, 20);
    return this.runTransaction(async (tx) => { const ref = this.ref("rule_versions", ruleVersionId), snapshot = await tx.get(ref), current = snapshot.data(); if (!snapshot.exists || !current || current.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404); if (current.status !== "proposed") throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from: current.status, to: status }); const findingSnapshots = await Promise.all(findings.map((finding) => tx.get(this.ref("drift_findings", finding.id as string)))); const ruleSnapshot = await tx.get(this.ref("rules", String(current.ruleId))), rule = ruleSnapshot.data(); if (!ruleSnapshot.exists || !rule || rule.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404); const projectId = projectIdForRule(rule); if (projectId) await this.requireActiveProject(tx, ctx, projectId); const now = new Date().toISOString(), patch: DocumentData = { status, updatedAt: now, ...(status === "rejected" ? { rejectionReason: reason!.trim() } : {}) }; tx.update(ref, patch);
      for (const [index, finding] of findings.entries()) { const findingSnapshot = findingSnapshots[index]!; if (findingSnapshot.exists && findingSnapshot.data()?.proposalVersionId === ruleVersionId) tx.update(this.ref("drift_findings", finding.id as string), { status: findingSnapshot.data()!.status === "accepted" ? "open" : findingSnapshot.data()!.status, proposalVersionId: null, reopenCount: Number(findingSnapshot.data()!.reopenCount ?? 0) + (findingSnapshot.data()!.status === "accepted" ? 1 : 0), updatedAt: now }); }
      await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: `rule_version.${status === "rejected" ? "reject" : "withdraw"}`, targetType: "rule_versions", targetId: ruleVersionId, requestId: requestId ?? `rule-version-${status}:${ruleVersionId}`, before: current, after: { ...current, ...patch } }, tx); return { ...current, ...patch }; });
  }
  async rejectRuleVersion(ctx: RuleStoreContext, id: string, reason: string, opts: RuleVersionActionOptions = {}) { return this.closeProposal(ctx, id, "rejected", reason, opts.requestId); }
  async withdrawRuleVersion(ctx: RuleStoreContext, id: string, opts: RuleVersionActionOptions = {}) { return this.closeProposal(ctx, id, "withdrawn", undefined, opts.requestId); }
  async redactAuditLogPayloads(ctx: RuleStoreContext, filter: { before: string } | { workspaceId: string }): Promise<{ count: number }> {
    if (ctx.actorKind !== "system") throw new RuleStoreError("FORBIDDEN", 403, { operation: "redactAuditLogPayloads" });
    const workspaceId = "workspaceId" in filter ? filter.workspaceId : ctx.workspaceId;
    if (workspaceId !== ctx.workspaceId) throw new RuleStoreError("FORBIDDEN", 403, { operation: "redactAuditLogPayloads" });
    const logs = await this.findServerDocuments("audit_logs", { ownerWorkspaceId: workspaceId });
    const now = new Date().toISOString();
    // Firestore's 500-write limit also applies to redaction.  Keeping each update
    // in its own small transaction makes a rerun safely resume after a partial run.
    for (const log of logs) if (log.payloadRedactedAt == null) await this.runTransaction(async (tx) => {
      const ref = this.ref("audit_logs", String(log.id)), current = await tx.get(ref);
      if (current.exists && current.data()?.payloadRedactedAt == null) tx.update(ref, { before: null, after: null, payloadRedactedAt: now });
    });
    return { count: logs.filter((log) => log.payloadRedactedAt == null).length };
  }
  async createAnalysisJob(ctx: RuleStoreContext, input: CreateAnalysisJobInput): Promise<{ job: AnalysisJob; created: boolean }> {
    validateAnalysisJobInput(input); const keyHash = sha256HexString(input.idempotencyKey);
    const create = async (): Promise<{ job: AnalysisJob; created: boolean }> => this.runTransaction(async (tx) => {
      const workspace = await tx.get(this.ref("workspaces", ctx.workspaceId));
      if (input.type !== "purge" && workspace.exists && (workspace.data()?.status === "deleted" || workspace.data()?.deletedAt)) throw new RuleStoreError("WORKSPACE_DELETED", 409, { workspaceId: ctx.workspaceId });
      if (input.type !== "purge") {
        const project = await tx.get(this.ref("projects", String(input.projectId))), value = project.data();
        if (!project.exists || !value || value.ownerWorkspaceId !== ctx.workspaceId || value.deletedAt || value.status !== "active") throw new RuleStoreError("PROJECT_DELETED", 409, { projectId: input.projectId });
      }
      const keyRef = this.ref("unique_keys", uniqueKeyId("job_idempotency", { idempotencyKeyHash: keyHash }));
      const existing = await tx.get(keyRef);
      if (existing.exists) {
        const key = existing.data()!;
        // The key ID is hash-only for contract compatibility. Never follow a
        // colliding reservation into another Workspace.
        if (key.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "job_idempotency" });
        const target = key.targetId as string, jobSnapshot = await tx.get(this.ref("analysis_jobs", target)), job = jobSnapshot.data() as AnalysisJob | undefined;
        if (jobSnapshot.exists && job?.ownerWorkspaceId === ctx.workspaceId) return { job, created: false };
        throw new RuleStoreError("IDEMPOTENCY_TARGET_MISSING", 409);
      }
      const id = generateUlid(), now = new Date().toISOString(); const job: AnalysisJob = { id, ownerWorkspaceId: ctx.workspaceId, projectId: input.projectId ?? null, type: input.type, payload: input.payload, status: "queued", attempts: 0, idempotencyKey: input.idempotencyKey, error: null, warnings: [], warningsOverflow: 0, createdAt: now, startedAt: null, finishedAt: null };
      await this.reserveUniqueKey(tx, "job_idempotency", { idempotencyKeyHash: keyHash, ownerWorkspaceId: ctx.workspaceId }, { targetTable: "analysis_jobs", targetId: id });
      if (input.type !== "purge") tx.update(this.ref("projects", String(input.projectId)), { mutationFenceAt: now });
      tx.create(this.ref("analysis_jobs", id), job);
      await this.appendAuditLog(ctx, { actor: auditActor(ctx), action: "job.create", targetType: "analysis_jobs", targetId: id, requestId: input.requestId ?? `job:${id}`, after: { type: input.type, idempotencyKey: input.idempotencyKey } }, tx); return { job, created: true };
    });
    try { return await create(); } catch (error) { if (!isRuleStoreError(error) || error.code !== "UNIQUE_VIOLATION") throw error; const key = await this.get(ctx, "unique_keys", uniqueKeyId("job_idempotency", { idempotencyKeyHash: keyHash })); if (!key) throw error; const job = await this.get(ctx, "analysis_jobs", key.targetId as string); if (!job) throw error; return { job: job as AnalysisJob, created: false }; }
  }
  async updateAnalysisJobStatus(ctx: RuleStoreContext, jobId: string, status: AnalysisJobStatus, opts: { error?: string; warnings?: JobWarning[]; maxAttempts?: number; requestId?: string } = {}): Promise<AnalysisJob> {
    return this.runTransaction(async (tx) => { const ref = this.ref("analysis_jobs", jobId), snapshot = await tx.get(ref); const job = snapshot.data() as AnalysisJob | undefined; if (!snapshot.exists || !job || job.ownerWorkspaceId !== ctx.workspaceId) throw new RuleStoreError("NOT_FOUND", 404); if (!validJobTransition(job.status, status)) throw new RuleStoreError("INVALID_STATUS_TRANSITION", 422, { from: job.status, to: status });
      if (status === "running" && job.type !== "purge") { const project = await tx.get(this.ref("projects", String(job.projectId))), value = project.data(); if (!project.exists || !value || value.ownerWorkspaceId !== ctx.workspaceId || value.deletedAt || value.status !== "active") throw new RuleStoreError("PROJECT_DELETED", 409, { projectId: job.projectId }); }
      const now = new Date().toISOString(); const warnings = opts.warnings ? opts.warnings.slice(0, JOB_LIMITS.maxWarnings) : (job.warnings as JobWarning[]); const overflow = opts.warnings ? Math.max(0, opts.warnings.length - JOB_LIMITS.maxWarnings) : Number(job.warningsOverflow ?? 0); const attempts = status === "failed" ? job.attempts + 1 : job.attempts; const finalStatus: AnalysisJobStatus = status === "failed" && attempts >= (opts.maxAttempts ?? JOB_LIMITS.defaultMaxAttempts) ? "dead" : status;
      const patch: DocumentData = { status: finalStatus, attempts, warnings, warningsOverflow: overflow, error: opts.error ?? (finalStatus === "done" ? null : job.error), ...(status === "running" ? { startedAt: now } : {}), ...(["done", "dead"].includes(finalStatus) ? { finishedAt: now } : {}) }; tx.update(ref, patch); if (finalStatus === "dead") await this.releaseUniqueKey(tx, "job_idempotency", { idempotencyKeyHash: sha256HexString(job.idempotencyKey), ownerWorkspaceId: ctx.workspaceId });
      if (status === "running" && job.type !== "purge") tx.update(this.ref("projects", String(job.projectId)), { mutationFenceAt: now });
      for (const warning of opts.warnings ?? []) await this.appendAuditLog(ctx, { actor: { kind: "ai", id: "worker" }, action: "ai.warning", targetType: "analysis_jobs", targetId: jobId, requestId: opts.requestId ?? `job:${jobId}`, after: warning }, tx); return { ...job, ...patch } as AnalysisJob;
    });
  }
}

export function validateRuleVersionInput(input: CreateRuleVersionInput): void {
  if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > RULE_VERSION_LIMITS.maxContentBytes) throw new RuleStoreError("INVALID_CONTENT", 422);
  if (typeof input.rationale !== "string" || Buffer.byteLength(input.rationale, "utf8") > RULE_VERSION_LIMITS.maxRationaleBytes) throw new RuleStoreError("INVALID_RATIONALE", 422);
  if (!Array.isArray(input.evidenceIds ?? []) || (input.evidenceIds ?? []).length > MAX_EVIDENCE_PER_VERSION || (input.evidenceIds ?? []).some((id) => typeof id !== "string")) throw new RuleStoreError("INVALID_EVIDENCE_IDS", 422);
  if (!Array.isArray(input.driftFindingIds ?? []) || (input.driftFindingIds ?? []).length > RULE_VERSION_LIMITS.maxDriftFindingIds || (input.driftFindingIds ?? []).some((id) => typeof id !== "string") || !["initial", "clarify", "tighten", "relax", "refactor", "deprecate"].includes(input.changeType)) throw new RuleStoreError("INVALID_RULE_VERSION", 422);
  if (input.aiSummary != null && (typeof input.aiSummary !== "string" || Buffer.byteLength(input.aiSummary, "utf8") > RULE_VERSION_LIMITS.maxAiSummaryBytes)) throw new RuleStoreError("INVALID_AI_SUMMARY", 422);
  if (input.provenance?.sourceType === "ai" && !(input.evidenceIds ?? []).length) throw new RuleStoreError("EVIDENCE_REQUIRED", 422);
}

export function validateAnalysisJobInput(input: CreateAnalysisJobInput): void { if (!ANALYSIS_JOB_TYPES.includes(input.type)) throw new RuleStoreError("INVALID_JOB_TYPE", 422); if (!/^[a-z_]+(:[A-Za-z0-9._-]+)+$/.test(input.idempotencyKey) || input.idempotencyKey.length > JOB_LIMITS.maxIdempotencyKeyLength || !validTypeKey(input.type, input.idempotencyKey)) throw new RuleStoreError("INVALID_IDEMPOTENCY_KEY", 422); if (!input.payload || Array.isArray(input.payload) || Buffer.byteLength(canonicalJson(input.payload), "utf8") > JOB_LIMITS.maxPayloadBytes) throw new RuleStoreError("PAYLOAD_TOO_LARGE", 422); if ((input.type === "purge") !== (input.projectId == null)) { if (input.type !== "purge" || input.projectId != null) throw new RuleStoreError("INVALID_PROJECT_ID", 422); } }
function validTypeKey(type: AnalysisJobType, key: string): boolean { const p = key.split(":"); return p[0] === type && JOB_LIMITS.idempotencyKeyParts[type].includes(p.length) && !(type === "purge" && p.length === 4 && p[1] !== "subject"); }
function validJobTransition(from: AnalysisJobStatus, to: AnalysisJobStatus): boolean { return (JOB_LIMITS.validStatusTransitions[from] ?? []).includes(to); }
