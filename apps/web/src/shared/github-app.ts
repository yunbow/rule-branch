import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { LIMITS } from "./contracts.ts";
import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, RuleStoreError, type CreateAnalysisJobInput, type DocumentData, type TransactionLike } from "./rulestore.ts";
import { log } from "./logger.ts";

/** The complete, deliberately fixed GitHub App permission surface (J55). */
export const GITHUB_APP_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", checks: "write", metadata: "read" });
export const GITHUB_APP_EVENTS = Object.freeze(["installation", "push", "pull_request"] as const);
/** GitHub documents a 25 MB webhook payload ceiling. Enforce the same ceiling while
 * streaming so a missing or forged Content-Length cannot cause unbounded buffering. */
export const MAX_GITHUB_WEBHOOK_BYTES = 25 * 1024 * 1024;
export type GitHubAppEvent = (typeof GITHUB_APP_EVENTS)[number];

export interface GitHubInstallationPayload { action?: string; installation: { id: string | number; account: { id: string | number; login: string; type: "Organization" | "User" }; repository_selection: "selected" | "all"; permissions?: Record<string, string>; created_at?: string }; sender: { id: string | number; login: string }; }
export type GitHubInstallation = GitHubInstallationPayload["installation"];
export interface GitHubRepository { id: string | number; name: string; full_name: string; private?: boolean; default_branch?: string; owner?: { login: string }; }
export interface GitHubPullRequest { state?: "open" | "closed"; merged: boolean; merged_at?: string | null; merge_commit_sha?: string | null; base: { ref: string }; html_url?: string; }
export interface GitHubAppApiClient { getInstallation(id: string): Promise<GitHubInstallationPayload | GitHubInstallation>; listInstallationRepositories(id: string): Promise<GitHubRepository[]>; createInstallationAccessToken(id: string, appJwt: string): Promise<{ token: string; expires_at: string }>; getPullRequest?(repository: GitHubRepository, number: number): Promise<GitHubPullRequest>; }

/** Production REST adapter; application services depend only on GitHubAppApiClient. */
export class GitHubAppRestClient implements GitHubAppApiClient {
  private readonly fetchImpl: typeof fetch;
  constructor(fetchImpl: typeof fetch = fetch) { this.fetchImpl = fetchImpl; }
  private async request(path: string, init: RequestInit): Promise<Response> { return this.fetchImpl(`https://api.github.com${path}`, { ...init, headers: { Accept: "application/vnd.github+json", ...init.headers } }); }
  async getInstallation(id: string): Promise<GitHubInstallationPayload> { throw new Error(`GitHubAppRestClient.getInstallation requires GitHubAppAuth; use authenticated() (${id})`); }
  async listInstallationRepositories(id: string): Promise<GitHubRepository[]> { throw new Error(`GitHubAppRestClient.listInstallationRepositories requires an installation token; use authenticated() (${id})`); }
  async createInstallationAccessToken(id: string, appJwt: string): Promise<{ token: string; expires_at: string }> { const response = await this.request(`/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: "POST", headers: { Authorization: `Bearer ${appJwt}` } }); if (!response.ok) throw new Error("GitHub installation token request failed"); return await response.json() as { token: string; expires_at: string }; }
  async getInstallationWithJwt(id: string, appJwt: string): Promise<GitHubInstallation> { const response = await this.request(`/app/installations/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${appJwt}` } }); if (!response.ok) throw new Error("GitHub installation lookup failed"); return await response.json() as GitHubInstallation; }
  async listInstallationRepositoriesWithToken(id: string, token: string): Promise<GitHubRepository[]> { const response = await this.request(`/installation/repositories?per_page=100`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error("GitHub installation repositories lookup failed"); const body = await response.json() as { repositories?: GitHubRepository[] }; return body.repositories ?? []; }
  async getPullRequestWithToken(repository: GitHubRepository, number: number, token: string): Promise<GitHubPullRequest> { const fullName = repository.full_name ?? `${repository.owner?.login ?? ""}/${repository.name ?? ""}`; if (!fullName.includes("/")) throw new Error("GitHub repository name is missing"); const response = await this.request(`/repos/${fullName.split("/").map(encodeURIComponent).join("/")}/pulls/${number}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error("GitHub pull request lookup failed"); return response.json() as Promise<GitHubPullRequest>; }
}

export interface GitHubAppAuthConfig { appId: string; privateKey: string; }
/** Generates a short-lived RS256 app JWT, then exchanges it without persisting or logging the token. */
export class GitHubAppAuth {
  private readonly config: GitHubAppAuthConfig; private readonly api: Pick<GitHubAppApiClient, "createInstallationAccessToken">;
  constructor(config: GitHubAppAuthConfig, api: Pick<GitHubAppApiClient, "createInstallationAccessToken">) { this.config = config; this.api = api; }
  createAppJwt(nowSeconds = Math.floor(Date.now() / 1000)): string { const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"); const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: this.config.appId })}`; const signer = createSign("RSA-SHA256"); signer.update(signingInput); signer.end(); return `${signingInput}.${signer.sign(this.config.privateKey).toString("base64url")}`; }
  async installationToken(installationId: string): Promise<string> { return (await this.api.createInstallationAccessToken(installationId, this.createAppJwt())).token; }
}

/** Wires the REST transport to App/installation credentials without exposing either token to callers. */
export class GitHubAppAuthenticatedClient implements GitHubAppApiClient {
  private readonly rest: GitHubAppRestClient; private readonly auth: GitHubAppAuth;
  constructor(rest: GitHubAppRestClient, auth: GitHubAppAuth) { this.rest = rest; this.auth = auth; }
  getInstallation(id: string): Promise<GitHubInstallation> { return this.rest.getInstallationWithJwt(id, this.auth.createAppJwt()); }
  async listInstallationRepositories(id: string): Promise<GitHubRepository[]> { return this.rest.listInstallationRepositoriesWithToken(id, await this.auth.installationToken(id)); }
  async getPullRequest(repository: GitHubRepository, number: number): Promise<GitHubPullRequest> { const installationId = (repository as GitHubRepository & { installationId?: string }).installationId; if (!installationId) throw new Error("GitHub repository installationId is missing"); return this.rest.getPullRequestWithToken(repository, number, await this.auth.installationToken(installationId)); }
  createInstallationAccessToken(id: string, appJwt: string): Promise<{ token: string; expires_at: string }> { return this.rest.createInstallationAccessToken(id, appJwt); }
}

const GITHUB_WEBHOOK_SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
export function verifyGitHubWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean { if (!signature || !GITHUB_WEBHOOK_SIGNATURE_PATTERN.test(signature)) return false; const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`; return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
async function readRequestBody(request: Request, maximumBytes: number): Promise<string | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
export interface GitHubAppLogger { info(message: string, fields?: Record<string, unknown>): void; }
const cloudLogger: GitHubAppLogger = { info: (message, fields) => log("INFO", message, fields) };

type QueueJob = (ctx: { workspaceId: string; actorUserId: null; actorKind: "github" }, input: CreateAnalysisJobInput) => void;
type Handler = (payload: GitHubInstallationPayload, tx: TransactionLike, requestId: string, queueJob: QueueJob) => Promise<void>;
export class GitHubAppService {
  private readonly handlers = new Map<GitHubAppEvent, Handler>();
  readonly store: FirestoreRuleStore; readonly api: GitHubAppApiClient; private readonly logger: GitHubAppLogger;
  constructor(store: FirestoreRuleStore, api: GitHubAppApiClient, logger: GitHubAppLogger = cloudLogger) {
    this.store = store; this.api = api; this.logger = logger;
    this.handlers.set("installation", (payload, tx, requestId) => this.handleInstallation(payload, tx, requestId));
    this.handlers.set("push", (payload, tx, requestId, queueJob) => this.handlePush(payload as any, tx, requestId, queueJob));
    this.handlers.set("pull_request", (payload, tx, requestId, queueJob) => this.handlePullRequest(payload as any, tx, requestId, queueJob));
  }
  register(event: GitHubAppEvent, handler: Handler): void { this.handlers.set(event, handler); }
  async receiveWebhook(request: Request, webhookSecret: string, maximumBytes = MAX_GITHUB_WEBHOOK_BYTES): Promise<Response> {
    const signature = request.headers.get("x-hub-signature-256");
    // Reject malformed headers before consuming an attacker-controlled body. A
    // correctly shaped but forged signature still requires hashing the body, so the
    // public endpoint also needs an edge rate limit (see gcp-deployment.md).
    if (!signature || !GITHUB_WEBHOOK_SIGNATURE_PATTERN.test(signature)) return new Response(null, { status: 401 });
    const raw = await readRequestBody(request, maximumBytes);
    if (raw === null) return Response.json({ error: "WEBHOOK_PAYLOAD_TOO_LARGE" }, { status: 413 });
    if (!verifyGitHubWebhookSignature(raw, signature, webhookSecret)) return new Response(null, { status: 401 });
    const event = request.headers.get("x-github-event") as GitHubAppEvent | null, deliveryId = request.headers.get("x-github-delivery");
    if (!event || !deliveryId || !this.handlers.has(event)) return Response.json({ error: "UNSUPPORTED_WEBHOOK_EVENT" }, { status: 422 });
    let payload: GitHubInstallationPayload; try { payload = JSON.parse(raw) as GitHubInstallationPayload; } catch { return Response.json({ error: "INVALID_WEBHOOK_PAYLOAD" }, { status: 422 }); }
    type PlannedJob = { ctx: { workspaceId: string; actorUserId: null; actorKind: "github" }; input: CreateAnalysisJobInput };
    const result = await this.store.runTransaction(async (tx) => {
      const delivery = this.store.documentRef("webhook_deliveries", deliveryId), existing = await tx.get(delivery);
      if (existing.exists) return { duplicate: true, jobs: Array.isArray(existing.data()?.pendingJobs) ? existing.data()!.pendingJobs as PlannedJob[] : [] };
      const jobs: PlannedJob[] = [], queueJob: QueueJob = (ctx, input) => { jobs.push({ ctx, input }); };
      await this.handlers.get(event)!(payload, tx, `webhook:${deliveryId}`, queueJob);
      const now = new Date().toISOString();
      tx.create(delivery, { id: deliveryId, event, receivedAt: now, processedAt: now, status: "processed", pendingJobs: jobs });
      return { duplicate: false, jobs };
    });
    // The durable delivery document is a small outbox: if job persistence or Cloud
    // Tasks dispatch fails, GitHub's retry replays these idempotent job plans.
    for (const job of result.jobs) await this.store.createAnalysisJob(job.ctx, job.input);
    // Customer content can exceed Firestore's 500-write transaction ceiling.  The
    // installation/workspace stop above is the visibility boundary; content is then
    // tombstoned in bounded, idempotent transactions.  A duplicate GitHub delivery
    // runs this again, so a failed partial sweep resumes safely.
    if (event === "installation" && payload.action === "deleted") await this.tombstoneDeletedInstallation(payload);
    if (event === "installation" && payload.action === "created") await this.restoreReinstalledWorkspace(payload);
    if (result.duplicate) this.logger.info("webhook.duplicate", { deliveryId, event });
    return Response.json({ ok: true });
  }
  private async tombstoneDeletedInstallation(payload: GitHubInstallationPayload): Promise<void> {
    const keys = await this.store.findServerDocuments("unique_keys", { id: `github_installation:${payload.installation.id}` });
    const targetId = keys[0]?.targetId; if (typeof targetId !== "string") return;
    const installation = (await this.store.getServerDocuments("installations", [targetId]))[0];
    if (!installation || installation.status !== "deleted" || typeof installation.ownerWorkspaceId !== "string" || typeof installation.deletedAt !== "string") return;
    const tables = (LIMITS.uninstall as { tombstoneTables: string[] }).tombstoneTables, chunkSize = 400;
    for (const table of tables) {
      const pending = (await this.store.findServerDocuments(table, { ownerWorkspaceId: installation.ownerWorkspaceId })).filter((entity) => !entity.deletedAt);
      for (let offset = 0; offset < pending.length; offset += chunkSize) await this.store.runTransaction(async (tx) => {
        for (const entity of pending.slice(offset, offset + chunkSize)) tx.update(this.store.documentRef(table, String(entity.id)), { deletedAt: installation.deletedAt });
      });
    }
  }
  /** Recover only the data tombstoned by the previous uninstall, and keep a
   * resumable marker until every batch has been restored. An old installation
   * remains deleted; only the newly verified installation is active. */
  private async restoreReinstalledWorkspace(payload: GitHubInstallationPayload): Promise<void> {
    const keys = await this.store.findServerDocuments("unique_keys", { id: `github_installation:${payload.installation.id}` });
    const installationId = keys[0]?.targetId;
    if (typeof installationId !== "string") return;
    const installation = (await this.store.getServerDocuments("installations", [installationId]))[0];
    if (!installation || installation.status !== "active" || typeof installation.ownerWorkspaceId !== "string") return;
    const workspaceId = installation.ownerWorkspaceId;
    const workspace = (await this.store.getServerDocuments("workspaces", [workspaceId]))[0];
    if (!workspace || workspace.kind !== "organization") return;
    if (workspace.purgeStartedAt) throw new RuleStoreError("WORKSPACE_PURGING", 409, { workspaceId });
    const stamp = typeof workspace.restorePendingDeletedAt === "string"
      ? workspace.restorePendingDeletedAt
      : typeof workspace.deletedAt === "string" ? workspace.deletedAt : null;
    if (!stamp) return;
    const workspaceRef = this.store.documentRef("workspaces", workspaceId);
    await this.store.runTransaction(async (tx) => {
      const snapshot = await tx.get(workspaceRef), current = snapshot.data();
      if (current?.purgeStartedAt) throw new RuleStoreError("WORKSPACE_PURGING", 409, { workspaceId });
      if (!snapshot.exists || !current || (current.deletedAt !== stamp && current.restorePendingDeletedAt !== stamp)) return;
      tx.update(workspaceRef, { status: "active", deletedAt: null, restorePendingDeletedAt: stamp });
    });
    const tables = (LIMITS.uninstall as { tombstoneTables: string[] }).tombstoneTables, chunkSize = 400;
    for (const table of tables) {
      const pending = (await this.store.findServerDocuments(table, { ownerWorkspaceId: workspaceId }))
        .filter((entity) => entity.deletedAt === stamp);
      for (let offset = 0; offset < pending.length; offset += chunkSize) {
        await this.store.runTransaction(async (tx) => {
          const currentInstallation = await tx.get(this.store.documentRef("installations", installationId));
          if (currentInstallation.data()?.status !== "active") throw new RuleStoreError("INSTALLATION_NOT_ACTIVE", 409);
          for (const entity of pending.slice(offset, offset + chunkSize)) {
            tx.update(this.store.documentRef(table, String(entity.id)), { deletedAt: null });
          }
        });
      }
    }
    await this.store.runTransaction(async (tx) => {
      const snapshot = await tx.get(workspaceRef);
      if (snapshot.data()?.restorePendingDeletedAt === stamp) tx.update(workspaceRef, { restorePendingDeletedAt: null });
    });
  }
  private async workspaceForInstallation(payload: GitHubInstallationPayload, tx: TransactionLike, requestId: string): Promise<string | null> {
    const account = payload.installation.account;
    if (account.type === "User") {
      const key = await tx.get(this.store.documentRef("unique_keys", `github_user:${account.id}`));
      if (!key.exists) return null;
      const user = await tx.get(this.store.documentRef("users", key.data()!.targetId as string));
      const workspaceId = user.data()?.personalWorkspaceId;
      if (typeof workspaceId !== "string") throw new RuleStoreError("NOT_FOUND", 404);
      const workspace = await tx.get(this.store.documentRef("workspaces", workspaceId));
      if (!workspace.exists || !workspace.data()) throw new RuleStoreError("NOT_FOUND", 404);
      if (workspace.data()!.purgeStartedAt) throw new RuleStoreError("WORKSPACE_PURGING", 409, { workspaceId });
      return workspaceId;
    }
    const orgKey = await tx.get(this.store.documentRef("unique_keys", `github_org:${account.id}`));
    if (orgKey.exists) {
      const workspaceId = orgKey.data()!.targetId;
      if (typeof workspaceId !== "string") throw new RuleStoreError("NOT_FOUND", 404);
      const workspace = await tx.get(this.store.documentRef("workspaces", workspaceId));
      if (!workspace.exists || !workspace.data()) throw new RuleStoreError("NOT_FOUND", 404);
      if (workspace.data()!.purgeStartedAt) throw new RuleStoreError("WORKSPACE_PURGING", 409, { workspaceId });
      return workspaceId;
    }
    const id = generateUlid(), now = new Date().toISOString();
    await this.store.reserveUniqueKey(tx, "github_org", { githubOrgId: String(account.id) }, { targetTable: "workspaces", targetId: id });
    tx.create(this.store.documentRef("workspaces", id), { id, kind: "organization", name: account.login, slug: `org-${String(account.id)}`, ownerUserId: null, githubOrgId: String(account.id), githubOrgLogin: account.login, status: "active", settings: { defaultLocale: "ja", prCommentRetentionDays: 180, evidenceRetentionDays: 365, allowAiAutoProposal: true, aiDataUsageConsent: false, aiProcessingAcknowledgedAt: null }, createdAt: now, updatedAt: now, deletedAt: null });
    await this.store.appendAuditLog({ workspaceId: id, actorUserId: null, actorKind: "github" }, { actor: { kind: "github", id: String(payload.sender.id) }, action: "workspace.create", targetType: "workspaces", targetId: id, requestId, after: { kind: "organization", githubOrgId: String(account.id) } }, tx); return id;
  }
  private async handleInstallation(payload: GitHubInstallationPayload, tx: TransactionLike, requestId: string): Promise<void> {
    const action = payload.action; if (action !== "created" && action !== "suspend" && action !== "unsuspend" && action !== "deleted") return;
    if (action === "deleted") { await this.handleInstallationDeleted(payload, tx, requestId); return; }
    if (payload.installation.repository_selection === "all") { this.logger.info("installation.repository_selection_all", { installationId: String(payload.installation.id) }); return; }
    const key = this.store.documentRef("unique_keys", `github_installation:${payload.installation.id}`); const existingKey = await tx.get(key);
    if (action !== "created") {
      if (!existingKey.exists) return; const ref = this.store.documentRef("installations", existingKey.data()!.targetId as string), snapshot = await tx.get(ref); if (!snapshot.exists) return;
      const before = snapshot.data()!, workspaceId = before.ownerWorkspaceId as string | null;
      if (action === "unsuspend" && workspaceId) {
        const workspace = await tx.get(this.store.documentRef("workspaces", workspaceId));
        if (!workspace.exists || !workspace.data()) throw new RuleStoreError("NOT_FOUND", 404);
        if (workspace.data()!.purgeStartedAt) throw new RuleStoreError("WORKSPACE_PURGING", 409, { workspaceId });
      }
      const status = action === "suspend" ? "suspended" : "active"; tx.update(ref, { status });
      if (workspaceId) await this.store.appendAuditLog({ workspaceId, actorUserId: null, actorKind: "github" }, { actor: { kind: "github", id: String(payload.sender.id) }, action: `installation.${action}`, targetType: "installations", targetId: ref.id, requestId, before: { status: before.status }, after: { status } }, tx); return;
    }
    const workspaceId = await this.workspaceForInstallation(payload, tx, requestId); const now = new Date().toISOString(); const data: DocumentData = { githubInstallationId: String(payload.installation.id), accountType: payload.installation.account.type, accountLogin: payload.installation.account.login, installedByGithubUserId: String(payload.sender.id), installedByGithubLogin: payload.sender.login, permissionsGranted: GITHUB_APP_PERMISSIONS, repositorySelection: "selected", status: "active", installedAt: payload.installation.created_at ?? now, deletedAt: null, purgeScheduledAt: null };
    if (existingKey.exists) { const ref = this.store.documentRef("installations", existingKey.data()!.targetId as string), prior = await tx.get(ref); tx.update(ref, { ...data, ownerWorkspaceId: workspaceId ?? prior.data()?.ownerWorkspaceId ?? null }); return; }
    const id = generateUlid(); tx.create(key, { id: key.id, kind: "github_installation", ownerWorkspaceId: null, targetTable: "installations", targetId: id, createdAt: now }); tx.create(this.store.documentRef("installations", id), { id, ownerWorkspaceId: workspaceId, ...data });
    if (workspaceId) await this.store.appendAuditLog({ workspaceId, actorUserId: null, actorKind: "github" }, { actor: { kind: "github", id: String(payload.sender.id) }, action: "installation.create", targetType: "installations", targetId: id, requestId, after: data }, tx);
  }
  /** UC-06: only customer content is immediately hidden.  Audit logs remain append-only. */
  private async handleInstallationDeleted(payload: GitHubInstallationPayload, tx: TransactionLike, requestId: string): Promise<void> {
    const key = await tx.get(this.store.documentRef("unique_keys", `github_installation:${payload.installation.id}`));
    if (!key.exists) return;
    const installationRef = this.store.documentRef("installations", String(key.data()!.targetId));
    const snapshot = await tx.get(installationRef), installation = snapshot.data();
    if (!snapshot.exists || !installation || !installation.ownerWorkspaceId) return;
    if (installation.status === "deleted" && typeof installation.deletedAt === "string") return;
    const workspaceId = String(installation.ownerWorkspaceId), deletedAt = new Date().toISOString();
    const purgeScheduledAt = new Date(Date.parse(deletedAt) + ((LIMITS.retentionClass as { uninstallGracePeriodDays: number }).uninstallGracePeriodDays * 24 * 60 * 60 * 1000)).toISOString();
    const workspace = await tx.get(this.store.documentRef("workspaces", workspaceId));
    tx.update(installationRef, { status: "deleted", deletedAt, purgeScheduledAt });
    if (workspace.exists && workspace.data()?.kind === "organization") tx.update(this.store.documentRef("workspaces", workspaceId), { status: "deleted", deletedAt });
    await this.store.appendAuditLog({ workspaceId, actorUserId: null, actorKind: "github" }, { actor: { kind: "github", id: String(payload.sender.id) }, action: "installation.delete", targetType: "installations", targetId: installationRef.id, requestId, before: { status: installation.status }, after: { status: "deleted", deletedAt, purgeScheduledAt } }, tx);
  }
  private async revisionPr(ctx: { workspaceId: string; actorUserId: null; actorKind: "github" }, tx: TransactionLike, pr: DocumentData, repository: DocumentData, merged: boolean, commitSha: string | null, closedAt: string | null, requestId: string, reason: "pr_merged" | "push", queueJob: QueueJob): Promise<void> {
    if (pr.status !== "draft_open") return;
    const now = new Date().toISOString(), ref = this.store.documentRef("revision_prs", pr.id as string);
    if (!merged) {
      tx.update(ref, { status: "closed", closedAt: closedAt ?? now }); await this.store.releaseUniqueKey(tx, "revision_pr_open", { repositoryId: String(repository.id), ownerWorkspaceId: ctx.workspaceId });
      await this.store.appendAuditLog(ctx, { actor: { kind: "github", id: "webhook" }, action: "pr.closed", targetType: "revision_prs", targetId: pr.id as string, requestId, before: pr, after: { status: "closed" } }, tx); return;
    }
    if (!commitSha) return;
    const verification = { state: "pending", checkedCommitSha: null, checkedAt: null, reason, mismatchedPaths: [] };
    tx.update(ref, { status: "merged", mergedAt: closedAt ?? now, mergeCommitSha: commitSha, verification }); await this.store.releaseUniqueKey(tx, "revision_pr_open", { repositoryId: String(repository.id), ownerWorkspaceId: ctx.workspaceId });
    await this.store.appendAuditLog(ctx, { actor: { kind: "github", id: "webhook" }, action: "pr.merged", targetType: "revision_prs", targetId: pr.id as string, requestId, before: pr, after: { status: "merged", mergeCommitSha: commitSha, verification } }, tx);
    queueJob(ctx, { type: "publish_verify", projectId: repository.projectId as string, payload: { repositoryId: repository.id, revisionPrId: pr.id, commitSha, reason }, idempotencyKey: `publish_verify:${pr.id}:${commitSha}`, requestId });
  }
  private async handlePullRequest(payload: any, tx: TransactionLike, requestId: string, queueJob: QueueJob): Promise<void> {
    if (payload.action !== "closed") return; const githubRepoId = String(payload.repository?.id ?? ""), number = Number(payload.number ?? payload.pull_request?.number); if (!githubRepoId || !Number.isInteger(number)) return;
    const repositories = await this.store.findServerDocuments("repositories", { githubRepoId }); const repository = repositories.find((r) => r.status === "active" && !r.deletedAt); if (!repository) return;
    const workspace = (await tx.get(this.store.documentRef("workspaces", String(repository.ownerWorkspaceId)))).data(); if (workspace?.status === "deleted" || workspace?.deletedAt) return;
    const ctx = { workspaceId: repository.ownerWorkspaceId as string, actorUserId: null, actorKind: "github" as const };
    if (typeof repository.projectId !== "string") return;
    await this.store.requireActiveProject(tx, ctx, repository.projectId);
    const prs = await this.store.findServerDocuments("revision_prs", { repositoryId: repository.id }); const pr = prs.find((value) => value.status === "draft_open" && Number(value.prNumber) === number); if (!pr) return;
    const gh = payload.pull_request ?? {}, baseMatches = gh.base?.ref === repository.defaultBranch;
    await this.revisionPr(ctx, tx, pr, repository, Boolean(gh.merged) && baseMatches, gh.merge_commit_sha ?? null, gh.merged_at ?? new Date().toISOString(), requestId, "pr_merged", queueJob);
  }
  private async handlePush(payload: any, tx: TransactionLike, requestId: string, queueJob: QueueJob): Promise<void> {
    const githubRepoId = String(payload.repository?.id ?? ""); const repositories = await this.store.findServerDocuments("repositories", { githubRepoId }); const repository = repositories.find((r) => r.status === "active" && !r.deletedAt); if (!repository || payload.ref !== `refs/heads/${repository.defaultBranch}`) return;
    const workspace = (await tx.get(this.store.documentRef("workspaces", String(repository.ownerWorkspaceId)))).data(); if (workspace?.status === "deleted" || workspace?.deletedAt) return;
    const ctx = { workspaceId: repository.ownerWorkspaceId as string, actorUserId: null, actorKind: "github" as const }, prs = await this.store.findServerDocuments("revision_prs", { repositoryId: repository.id });
    if (typeof repository.projectId !== "string") return;
    await this.store.requireActiveProject(tx, ctx, repository.projectId);
    const installation = typeof repository.installationId === "string" ? (await this.store.getServerDocuments("installations", [repository.installationId]))[0] : undefined;
    for (const pr of prs.filter((p) => p.status === "draft_open")) {
      if (!this.api.getPullRequest) continue; const remote = await this.api.getPullRequest({ ...payload.repository, installationId: installation?.githubInstallationId }, Number(pr.prNumber));
      if (remote.merged && remote.base.ref === repository.defaultBranch && remote.merge_commit_sha) {
        await this.revisionPr(ctx, tx, pr, repository, true, remote.merge_commit_sha, remote.merged_at ?? null, requestId, "push", queueJob);
        // Artifact selection must include the merge reconciled by this push.
        Object.assign(pr, { status: "merged", mergedAt: remote.merged_at ?? new Date().toISOString(), mergeCommitSha: remote.merge_commit_sha });
      }
      else if (remote.state === "closed") await this.revisionPr(ctx, tx, pr, repository, false, null, remote.merged_at ?? null, requestId, "push", queueJob);
    }
    const changed = new Set((payload.commits ?? []).flatMap((c: any) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]));
    // IMPL-016 step 3.  Keep this between PR reconciliation and artifact checks.
    const manifests = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "poetry.lock", "uv.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "composer.lock"];
    const paths = [...changed].filter((path) => { const basename = String(path).split("/").pop() ?? ""; return manifests.includes(basename) || /^requirements.*\.txt$/.test(basename); });
    if (paths.length) {
      const triggerId = generateUlid(), now = new Date().toISOString();
      tx.create(this.store.documentRef("change_triggers", triggerId), { id: triggerId, ownerWorkspaceId: ctx.workspaceId, projectId: repository.projectId, type: "dependency_update", source: { repositoryId: repository.id, commitSha: payload.after, before: payload.before ?? null, paths }, detectedBy: "github", resultingFindingIds: [], processedAt: null, truncation: null, createdAt: now, updatedAt: now, deletedAt: null });
      queueJob(ctx, { type: "drift_scan", projectId: repository.projectId as string, payload: { triggerId }, idempotencyKey: `drift_scan:${triggerId}`, requestId });
    }
    const merged = prs.filter((p) => p.status === "merged").sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)) || Number(b.prNumber) - Number(a.prNumber))[0];
    if (merged) { const artifacts = await this.store.findServerDocuments("compiled_artifacts", { revisionPrId: merged.id }); if (artifacts.some((a) => changed.has(a.path)) || (Array.isArray(merged.expectedDeletedPaths) && merged.expectedDeletedPaths.some((path: unknown) => typeof path === "string" && changed.has(path)))) { const sha = String(payload.after ?? merged.mergeCommitSha); queueJob(ctx, { type: "publish_verify", projectId: repository.projectId as string, payload: { repositoryId: repository.id, revisionPrId: merged.id, commitSha: sha, reason: "push" }, idempotencyKey: `publish_verify:${merged.id}:${sha}`, requestId }); } }
  }
  private async addInstallerMembership(user: DocumentData, installation: DocumentData, requestId: string, allowAdminAddition = true): Promise<void> {
    const workspaceId = installation.ownerWorkspaceId as string | null; if (!workspaceId) return;
    const userId = String(user.id);
    await this.store.runTransaction(async (tx) => {
      const workspaceRef = this.store.documentRef("workspaces", workspaceId);
      const [workspaceSnapshot, key] = await Promise.all([
        tx.get(workspaceRef), tx.get(this.store.documentRef("unique_keys", `workspace_member:${workspaceId}:${userId}`)),
      ]);
      const workspace = workspaceSnapshot.data();
      if (!workspaceSnapshot.exists || !workspace || workspace.status === "deleted" || workspace.deletedAt || key.exists) return;
      // A removed installer must never regain organization access by logging in
      // or revisiting /setup. A new invitation is the only way back in.
      if (Array.isArray(workspace.revokedInstallerUserIds) && workspace.revokedInstallerUserIds.includes(userId)) return;
      const owners = await this.store.findServerDocuments("workspace_members", { workspaceId, role: "owner" });
      // Login backfill is strictly the zero-owner rescue path. Only an explicit
      // verified setup callback can enroll a new installer as admin.
      if (!allowAdminAddition && owners.length > 0) return;
      const role = owners.length === 0 ? "owner" : "admin";
      const id = generateUlid(), now = new Date().toISOString();
      await this.store.reserveUniqueKey(tx, "workspace_member", { workspaceId, userId }, { targetTable: "workspace_members", targetId: id });
      tx.create(this.store.documentRef("workspace_members", id), { id, workspaceId, userId, role, invitedByUserId: null, joinedVia: "installer", invitationId: null, createdAt: now, updatedAt: now });
      // Serialize against member removals which write this Workspace document.
      tx.update(workspaceRef, { updatedAt: now });
    });
  }
  async setup(userId: string, installationId: string, setupAction: string | null, requestId = `setup:${generateUlid()}`): Promise<{ workspaceId: string; installationId: string }> {
    if (!setupAction) throw new RuleStoreError("MISSING_SETUP_ACTION", 422);
    const fetchedInstallation = await this.api.getInstallation(installationId);
    const installationDetails = "installation" in fetchedInstallation ? fetchedInstallation.installation : fetchedInstallation;
    if (installationDetails.repository_selection === "all") throw new RuleStoreError("REPOSITORY_SELECTION_ALL_NOT_ALLOWED", 422);
    const userSnapshot = await this.store.documentRef("users", userId).get();
    if (!userSnapshot.exists) throw new RuleStoreError("UNAUTHENTICATED", 401);
    const user = userSnapshot.data()!;
    // The App-authenticated REST response identifies the installation, not the
    // browser user who installed it. Only a signed webhook may establish or
    // change installedByGithubUserId; never synthesize its sender from a session.
    const key = await this.store.documentRef("unique_keys", `github_installation:${installationId}`).get();
    if (!key.exists) throw new RuleStoreError("INSTALLATION_NOT_READY", 409);
    const installation = (await this.store.documentRef("installations", key.data()!.targetId as string).get()).data()!;
    if (!installation || installation.status !== "active" || installation.deletedAt) throw new RuleStoreError("NOT_FOUND", 404);
    if (String(user.githubUserId) !== String(installation.installedByGithubUserId)) throw new RuleStoreError("INSTALLER_MISMATCH", 403); await this.addInstallerMembership(user, installation, requestId);
    if (typeof installation.ownerWorkspaceId !== "string") throw new RuleStoreError("NOT_FOUND", 404);
    return { workspaceId: installation.ownerWorkspaceId, installationId: String(installation.githubInstallationId) };
  }
  async backfillInstallerOwnership(user: DocumentData, requestId = `login-backfill:${generateUlid()}`): Promise<void> {
    const installations = await this.store.findServerDocuments("installations", { installedByGithubUserId: String(user.githubUserId) });
    for (let installation of installations.filter((item) => item.status === "active" && !item.deletedAt)) {
      // A User installation can arrive before OAuth has created its personal Workspace.
      // It is linked here; Organization installations already own their Workspace.
      if (!installation.ownerWorkspaceId && installation.accountType === "User") {
        const workspaceId = user.personalWorkspaceId as string;
        await this.store.runTransaction(async (tx) => { const ref = this.store.documentRef("installations", installation.id as string), current = await tx.get(ref); if (current.exists && !current.data()!.ownerWorkspaceId) tx.update(ref, { ownerWorkspaceId: workspaceId }); });
        installation = { ...installation, ownerWorkspaceId: workspaceId };
      }
      await this.addInstallerMembership(user, installation, requestId, false);
    }
  }
  async repositories(installationId: string): Promise<GitHubRepository[]> { return this.api.listInstallationRepositories(installationId); }
}
