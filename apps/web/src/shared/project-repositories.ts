import { requireRole } from "./authz.ts";
import type { GitHubAppApiClient, GitHubRepository } from "./github-app.ts";
import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, RuleStoreError, uniqueKeyId, type DocumentData, type LinkRepositoryInput } from "./rulestore.ts";
import { userActor, userContext } from "./service-context.ts";

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PROFILE = { name: "RuleBranch", tone: "helpful", verbosity: "balanced" };
export interface ProjectInput { name: string; slug: string; description?: string | null; companionProfile?: Record<string, unknown>; primaryLanguages?: string[]; frameworks?: string[]; focusThemes?: string[]; installationId?: string; repositoryGithubIds: Array<string | number>; requestId?: string; }
export interface RepositoryInput { projectId: string; githubRepoId: string | number; installationId?: string; provider?: "github"; requestId?: string; }
export interface DeleteProjectInput { confirmName: string; requestId?: string; }

function strings(value: unknown, field: string, maximum: number): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new RuleStoreError(`INVALID_${field.toUpperCase()}`, 422);
  if (value.length > maximum) throw new RuleStoreError(`INVALID_${field.toUpperCase()}`, 422, { maximum });
  return value;
}

/** Project/Repository domain service. GitHub access stays behind the existing App API port. */
export class ProjectRepositoryService {
  readonly store: FirestoreRuleStore;
  private readonly github: Pick<GitHubAppApiClient, "listInstallationRepositories">;
  constructor(store: FirestoreRuleStore, github: Pick<GitHubAppApiClient, "listInstallationRepositories">) { this.store = store; this.github = github; }
  private ctx(workspaceId: string, userId: string | null) { return userContext(workspaceId, userId); }
  private async selected(workspaceId: string, githubRepoIds: string[], installationId?: string): Promise<Map<string, { installation: DocumentData; repository: GitHubRepository }>> {
    const installations = (await this.store.list({ workspaceId, actorUserId: null }, "installations", { status: "active" })).filter((item) => item.repositorySelection === "selected" && (!installationId || item.id === installationId));
    const found = new Map<string, { installation: DocumentData; repository: GitHubRepository }>();
    const repositoriesByInstallation = await Promise.all(installations.map(async (installation) => ({ installation, repositories: await this.github.listInstallationRepositories(String(installation.githubInstallationId)) })));
    for (const { installation, repositories } of repositoriesByInstallation) for (const repository of repositories) { const id = String(repository.id); if (githubRepoIds.includes(id) && !found.has(id)) found.set(id, { installation, repository }); }
    if (found.size !== githubRepoIds.length) throw new RuleStoreError("REPOSITORY_NOT_SELECTED", 422);
    return found;
  }
  private linkInput(projectId: string, selected: { installation: DocumentData; repository: GitHubRepository }, requestId: string): LinkRepositoryInput {
    const repository = selected.repository, fullName = repository.full_name, owner = repository.owner?.login ?? fullName.split("/")[0];
    if (!fullName || !owner) throw new RuleStoreError("INVALID_GITHUB_REPOSITORY", 422);
    return { projectId, installationId: selected.installation.id as string, githubRepoId: String(repository.id), fullName, githubOwnerLogin: owner, defaultBranch: repository.default_branch ?? "main", requestId };
  }
  async createProject(workspaceId: string, userId: string | null, input: ProjectInput): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "admin");
    if (!input || typeof input.name !== "string" || !input.name.trim() || typeof input.slug !== "string" || !SLUG.test(input.slug)) throw new RuleStoreError("INVALID_PROJECT", 422);
    const repositoryGithubIds = Array.isArray(input.repositoryGithubIds) ? input.repositoryGithubIds.map(String) : [];
    if (!repositoryGithubIds.length || new Set(repositoryGithubIds).size !== repositoryGithubIds.length) throw new RuleStoreError("INVALID_REPOSITORY_GITHUB_IDS", 422);
    const primaryLanguages = strings(input.primaryLanguages, "primaryLanguages", 20), frameworks = strings(input.frameworks, "frameworks", 20), focusThemes = strings(input.focusThemes, "focusThemes", 10);
    const selected = await this.selected(workspaceId, repositoryGithubIds, input.installationId), id = generateUlid(), now = new Date().toISOString(), requestId = input.requestId ?? `project:${id}`, ctx = this.ctx(workspaceId, userId!);
    const project = await this.store.runTransaction(async (tx) => {
      const projectKeyRef = this.store.documentRef("unique_keys", uniqueKeyId("project_slug", { ownerWorkspaceId: workspaceId, slug: input.slug }));
      if ((await tx.get(projectKeyRef)).exists) throw new RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "project_slug", value: `${workspaceId}:${input.slug}` });
      const links = repositoryGithubIds.map((githubRepoId) => this.linkInput(id, selected.get(githubRepoId)!, requestId));
      await this.store.linkRepositories(ctx, links, tx);
      const value: DocumentData = { id, ownerWorkspaceId: workspaceId, name: input.name.trim(), slug: input.slug, description: input.description ?? null, status: "active", companionProfile: { ...PROFILE, ...(input.companionProfile ?? {}) }, primaryLanguages, frameworks, focusThemes, createdAt: now, updatedAt: now, deletedAt: null, bootstrapPending: true };
      tx.create(projectKeyRef, { id: projectKeyRef.id, kind: "project_slug", ownerWorkspaceId: workspaceId, targetTable: "projects", targetId: id, createdAt: now });
      tx.create(this.store.documentRef("projects", id), value);
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "project.create", targetType: "projects", targetId: id, requestId, after: { slug: input.slug } }, tx);
      return value;
    });
    // K3: the transaction has committed before the job reservation/task path begins.
    await this.store.createAnalysisJob(ctx, { type: "bootstrap", projectId: id, payload: {}, idempotencyKey: `bootstrap:${id}`, requestId });
    await this.store.markProjectBootstrapQueued(ctx, id);
    return { ...project, bootstrapPending: false };
  }
  async addRepository(workspaceId: string, userId: string | null, input: RepositoryInput): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "admin");
    if (!input || input.provider !== undefined && input.provider !== "github") throw new RuleStoreError("INVALID_REPOSITORY_PROVIDER", 422);
    if (typeof input.projectId !== "string" || !input.projectId || input.githubRepoId == null) throw new RuleStoreError("INVALID_REPOSITORY", 422);
    const ctx = this.ctx(workspaceId, userId!), project = await this.store.get(ctx, "projects", input.projectId); if (!project || project.status !== "active") throw new RuleStoreError("NOT_FOUND", 404);
    const id = String(input.githubRepoId), selected = await this.selected(workspaceId, [id], input.installationId), requestId = input.requestId ?? `repository:${input.projectId}:${id}`;
    return this.store.runTransaction(async (tx) => {
      const projectSnapshot = await tx.get(this.store.documentRef("projects", input.projectId)), current = projectSnapshot.data();
      if (!projectSnapshot.exists || !current || current.ownerWorkspaceId !== workspaceId || current.deletedAt || current.status !== "active") throw new RuleStoreError("NOT_FOUND", 404);
      const linked = await this.store.linkRepositories(ctx, [this.linkInput(input.projectId, selected.get(id)!, requestId)], tx);
      tx.update(this.store.documentRef("projects", input.projectId), { updatedAt: new Date().toISOString() });
      return linked[0]!;
    });
  }
  async deleteProject(workspaceId: string, userId: string | null, projectId: string, input: DeleteProjectInput): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "admin");
    if (!input || typeof input.confirmName !== "string") throw new RuleStoreError("PROJECT_NAME_MISMATCH", 422);
    const ctx = this.ctx(workspaceId, userId!), requestId = input.requestId ?? `project-delete:${projectId}`;
    return this.store.runTransaction(async (tx) => {
      const projectRef = this.store.documentRef("projects", projectId);
      const projectSnapshot = await tx.get(projectRef), project = projectSnapshot.data();
      if (!projectSnapshot.exists || !project || project.ownerWorkspaceId !== workspaceId || project.deletedAt || project.status !== "active") throw new RuleStoreError("NOT_FOUND", 404);
      if (input.confirmName !== project.name) throw new RuleStoreError("PROJECT_NAME_MISMATCH", 422);
      const [repositoryQuery, jobQuery] = await Promise.all([
        tx.getQuery(this.store.queryRef("repositories", { ownerWorkspaceId: workspaceId, projectId })),
        tx.getQuery(this.store.queryRef("analysis_jobs", { ownerWorkspaceId: workspaceId, projectId, status: "running" })),
      ]);
      const repositorySnapshots = repositoryQuery.docs.filter((snapshot) => !snapshot.data()?.deletedAt), jobSnapshots = jobQuery.docs.filter((snapshot) => !snapshot.data()?.deletedAt);
      if (repositorySnapshots.length > 440) throw new RuleStoreError("PROJECT_TOO_LARGE", 409, { maximumRepositories: 440 });
      const slugKeyRef = this.store.documentRef("unique_keys", uniqueKeyId("project_slug", { ownerWorkspaceId: workspaceId, slug: String(project.slug) }));
      const slugKey = await tx.get(slugKeyRef);
      const now = new Date().toISOString(), hasActiveLease = repositorySnapshots.some((snapshot) => { const lease = snapshot.data()?.compileLease, expiresAt = lease && typeof lease === "object" ? (lease as DocumentData).expiresAt : null; return typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.parse(now); });
      if (hasActiveLease || jobSnapshots.length) throw new RuleStoreError("PROJECT_BUSY", 409);
      const patch = { status: "archived", updatedAt: now, deletedAt: now };
      tx.update(projectRef, patch);
      for (const snapshot of repositorySnapshots) {
        const repository = snapshot.data();
        if (snapshot.exists && repository?.ownerWorkspaceId === workspaceId && repository.projectId === projectId && !repository.deletedAt) tx.update(this.store.documentRef("repositories", snapshot.id), { status: "removed", updatedAt: now, deletedAt: now });
      }
      if (slugKey.exists && slugKey.data()?.ownerWorkspaceId === workspaceId && slugKey.data()?.targetTable === "projects" && slugKey.data()?.targetId === projectId) tx.delete(slugKeyRef);
      await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "project.delete", targetType: "projects", targetId: projectId, requestId, before: { status: project.status, name: project.name, slug: project.slug }, after: { status: "archived", deletedAt: now, repositoriesRemoved: repositorySnapshots.length } }, tx);
      return { ...project, ...patch };
    });
  }
  async unlinkRepository(workspaceId: string, userId: string | null, repositoryId: string, requestId = `repository-unlink:${repositoryId}`): Promise<DocumentData> {
    await requireRole(this.store, workspaceId, userId, "admin"); const ctx = this.ctx(workspaceId, userId!);
    return this.store.runTransaction(async (tx) => { const ref = this.store.documentRef("repositories", repositoryId), snapshot = await tx.get(ref), repository = snapshot.data(); if (!snapshot.exists || !repository || repository.ownerWorkspaceId !== workspaceId) throw new RuleStoreError("NOT_FOUND", 404); if (repository.status === "removed") return repository; const now = new Date().toISOString(); tx.update(ref, { status: "removed", updatedAt: now, deletedAt: now, compileLease: null }); await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "repository.unlink", targetType: "repositories", targetId: repositoryId, requestId, before: { status: repository.status }, after: { status: "removed" } }, tx); return { ...repository, status: "removed", updatedAt: now, deletedAt: now, compileLease: null }; });
  }
  async listProjects(workspaceId: string, userId: string | null) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "projects"); }
  async getProject(workspaceId: string, userId: string | null, id: string) { await requireRole(this.store, workspaceId, userId, "viewer"); const project = await this.store.get(this.ctx(workspaceId, userId!), "projects", id); if (!project) throw new RuleStoreError("NOT_FOUND", 404); return project; }
  async listRepositories(workspaceId: string, userId: string | null, projectId?: string) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "repositories", projectId ? { projectId } : {}); }
  async recompile(workspaceId: string, userId: string | null, repositoryId: string, requestId: string): Promise<{ jobId: string }> {
    await requireRole(this.store, workspaceId, userId, "maintainer"); const ctx = this.ctx(workspaceId, userId!);
    const repository = await this.store.get(ctx, "repositories", repositoryId); if (!repository || repository.status !== "active") throw new RuleStoreError("NOT_FOUND", 404);
    const result = await this.store.createAnalysisJob(ctx, { type: "compile", projectId: repository.projectId as string, payload: { repositoryId, manual: true }, idempotencyKey: `compile:${repositoryId}:${requestId}`, requestId });
    await this.store.appendAuditLog(ctx, { actor: userActor(userId!), action: "repository.recompile", targetType: "repositories", targetId: repositoryId, requestId, after: { jobId: result.job.id } });
    return { jobId: result.job.id };
  }
  async listRevisionPrs(workspaceId: string, userId: string | null, repositoryId?: string) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "revision_prs", repositoryId ? { repositoryId } : {}); }
  async listCompiledArtifacts(workspaceId: string, userId: string | null, repositoryId?: string) { await requireRole(this.store, workspaceId, userId, "viewer"); return this.store.list(this.ctx(workspaceId, userId!), "compiled_artifacts", repositoryId ? { repositoryId } : {}); }
}
