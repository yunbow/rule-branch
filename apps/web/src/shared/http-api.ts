import { listAuditLogs } from "./audit-logs.ts";
import { AuthService, SESSION_MAX_AGE_MS, signSession, verifySession } from "./auth.ts";
import { isRuleStoreError, RuleStoreError } from "./rulestore.ts";
import { UserPreferencesService } from "./user-preferences.ts";
import { GitHubAppService } from "./github-app.ts";
import { requireRole } from "./authz.ts";
import { WorkspaceInvitationsService } from "./workspace-invitations.ts";
import { ProjectRepositoryService } from "./project-repositories.ts";
import { RulesService } from "./rules.ts";
import { DriftService } from "./drift.ts";
import { getJob, listProjectJobs } from "./analysis-jobs.ts";
import { ANALYSIS_JOB_TYPES, type AnalysisJobStatus, type AnalysisJobType, type FirestoreRuleStore } from "./rulestore.ts";
import { userContext } from "./service-context.ts";
import { requireRequestedWith } from "./request-security.ts";
import { safeRelativeUrl } from "./auth-navigation.ts";
import { rejectJudgeDemoMutation } from "./demo-session.ts";

export { requireRequestedWith } from "./request-security.ts";

const jsonError = (error: unknown): Response => {
  if (isRuleStoreError(error)) return Response.json({ error: error.code, details: error.details }, { status: error.status });
  // Keep the client response generic, but retain the server-side cause needed to
  // diagnose operational failures such as a downstream Cloud Tasks request.
  console.error(JSON.stringify({ severity: "ERROR", message: "api.request.failed", error: error instanceof Error ? error.message : String(error) }));
  return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
};
const cookie = (name: string, value: string, extra = "") => `${name}=${value}; HttpOnly; Path=/; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}${extra}`;
const sessionUser = (request: Request, secret: string) => verifySession(request.headers.get("cookie")?.match(/(?:^|; )rulebranch_session=([^;]+)/)?.[1], secret)?.userId ?? null;
const requireUser = (request: Request, secret: string): string => { const userId = sessionUser(request, secret); if (!userId) throw new RuleStoreError("UNAUTHENTICATED", 401); return userId; };
const mutationUser = (request: Request, secret: string): string | null => { const userId = sessionUser(request, secret); rejectJudgeDemoMutation(userId); return userId; };
const requireMutationUser = (request: Request, secret: string): string => { const userId = mutationUser(request, secret); if (!userId) throw new RuleStoreError("UNAUTHENTICATED", 401); return userId; };
const requireWorkspaceIdFromQuery = (request: Request): string => { const workspaceId = new URL(request.url).searchParams.get("workspaceId"); if (!workspaceId) throw new RuleStoreError("INVALID_WORKSPACE_ID", 422); return workspaceId; };
const requireWorkspaceIdFromBody = (body: Record<string, unknown>): string => { if (typeof body.ownerWorkspaceId !== "string" || !body.ownerWorkspaceId) throw new RuleStoreError("INVALID_WORKSPACE_ID", 422); return body.ownerWorkspaceId; };
/** Read-only evidence BFF. Individual reads retain RuleStore tenant scoping. */
export function createEvidenceHandlers(store: FirestoreRuleStore, sessionSecret: string) {
  return { list: async (request: Request): Promise<Response> => { try {
    const userId = requireUser(request, sessionSecret);
    const url = new URL(request.url), workspaceId = requireWorkspaceIdFromQuery(request);
    const ids = (url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length > 20) throw new RuleStoreError("EVIDENCE_LIMIT_EXCEEDED", 422, { maximum: 20 });
    await requireRole(store, workspaceId, userId, "viewer");
    const ctx = userContext(workspaceId, userId);
    const evidence = (await Promise.all(ids.map((id) => store.get(ctx, "evidence", id)))).filter((item): item is NonNullable<typeof item> => item !== null);
    return Response.json({ evidence });
  } catch (error) { return jsonError(error); } } };
}
const oauthCookie = (name: string, value: string, extra = "") => `${name}=${value}; HttpOnly; Path=/api/auth/github; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}${extra}`;
const oauthNext = (request: Request): string => {
  const encoded = request.headers.get("cookie")?.match(/(?:^|; )rulebranch_oauth_next=([^;]*)/)?.[1];
  if (!encoded) return "/";
  try {
    return safeRelativeUrl(decodeURIComponent(encoded)) ?? "/";
  } catch {
    return "/";
  }
};
const authErrorRedirect = (url: URL, code: string, next: string): Response => {
  const loginUrl = new URL("/login", url);
  loginUrl.searchParams.set("error", code);
  if (next !== "/") loginUrl.searchParams.set("next", next);
  const response = new Response(null, { status: 302, headers: { Location: loginUrl.toString() } });
  response.headers.append("Set-Cookie", oauthCookie("rulebranch_oauth_state", "", "; Max-Age=0"));
  response.headers.append("Set-Cookie", oauthCookie("rulebranch_oauth_next", "", "; Max-Age=0"));
  return response;
};

export function createAuthHandlers(auth: AuthService, sessionSecret: string) {
  return {
    callback: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const next = oauthNext(request);
      const state = url.searchParams.get("state");
      const expected = request.headers.get("cookie")?.match(/(?:^|; )rulebranch_oauth_state=([^;]+)/)?.[1];
      if (!state || !expected || state !== expected) return authErrorRedirect(url, "OAUTH_STATE_MISMATCH", next);

      const providerError = url.searchParams.get("error");
      if (providerError) return authErrorRedirect(url, providerError === "access_denied" ? "OAUTH_CANCELLED" : "OAUTH_FAILED", next);

      try {
        const code = url.searchParams.get("code");
        if (!code) return authErrorRedirect(url, "MISSING_OAUTH_CODE", next);
        const user = await auth.loginWithCode(code);
        const publicUrl = process.env.RULEBRANCH_PUBLIC_URL ?? url.toString();
        const response = new Response(null, { status: 302, headers: { Location: new URL(next, publicUrl).toString() } });
        response.headers.append("Set-Cookie", cookie("rulebranch_session", signSession({ userId: user.id, issuedAt: Date.now() }, sessionSecret), `; Max-Age=${SESSION_MAX_AGE_MS / 1000}`));
        response.headers.append("Set-Cookie", oauthCookie("rulebranch_oauth_state", "", "; Max-Age=0"));
        response.headers.append("Set-Cookie", oauthCookie("rulebranch_oauth_next", "", "; Max-Age=0"));
        return response;
      } catch (error) {
        console.error(JSON.stringify({ severity: "ERROR", message: "oauth.callback.failed", error: error instanceof Error ? error.message : "unknown" }));
        const code = isRuleStoreError(error) ? error.code : "INTERNAL_ERROR";
        return authErrorRedirect(url, code, next);
      }
    },
  };
}
export function createLogoutHandlers() { return { logout: async (request: Request): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; const response = new Response(null, { status: 204 }); response.headers.set("Set-Cookie", cookie("rulebranch_session", "", "; Max-Age=0")); return response; } }; }
export function createDevLoginHandlers(auth: AuthService, sessionSecret: string) { return { login: async (request: Request): Promise<Response> => { if (process.env.RULEBRANCH_DEV_LOGIN !== "1" || process.env.NODE_ENV === "production") return new Response(null, { status: 404 }); const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; if ((typeof body.githubUserId !== "string" && typeof body.githubUserId !== "number") || typeof body.login !== "string") return Response.json({ error: "INVALID_GITHUB_LOGIN" }, { status: 422 }); const user = await auth.loginGitHubUser({ id: body.githubUserId as string | number, login: body.login }); const response = Response.json({ userId: user.id, firstWorkspaceId: user.personalWorkspaceId }); response.headers.set("Set-Cookie", cookie("rulebranch_session", signSession({ userId: user.id, issuedAt: Date.now() }, sessionSecret), `; Max-Age=${SESSION_MAX_AGE_MS / 1000}`)); return response; } catch (error) { return jsonError(error); } } }; }
export function createMeHandlers(store: FirestoreRuleStore, sessionSecret: string) { return { get: async (request: Request): Promise<Response> => { try { const userId = requireUser(request, sessionSecret); const user = (await store.getServerDocuments("users", [userId]))[0]; if (!user) throw new RuleStoreError("UNAUTHENTICATED", 401); const [members, pending] = await Promise.all([store.findServerDocuments("workspace_members", { userId }), store.findServerDocuments("workspace_invitations", { invitedGithubUserId: String(user.githubUserId), status: "pending" })]); const activeMembers = members.filter((member) => !member.deletedAt), workspaceDocuments = (await store.getServerDocuments("workspaces", activeMembers.map((member) => String(member.workspaceId)))).filter((workspace) => workspace.status !== "deleted" && !workspace.deletedAt), workspacesById = new Map(workspaceDocuments.map((workspace) => [String(workspace.id), workspace])); const workspaces = activeMembers.map((member) => { const workspace = workspacesById.get(String(member.workspaceId)); return workspace ? { id: workspace.id, kind: workspace.kind, name: workspace.name, slug: workspace.slug, githubOrgLogin: workspace.githubOrgLogin, role: member.role } : null; }).filter((workspace) => workspace !== null); return Response.json({ user: { id: user.id, login: user.login, displayName: user.displayName, locale: user.locale, personalWorkspaceId: user.personalWorkspaceId }, workspaces, pendingInvitations: pending.filter((invitation) => !invitation.deletedAt).length }); } catch (error) { return jsonError(error); } } }; }
export function createJobHandlers(store: FirestoreRuleStore, sessionSecret: string) {
  const requireContext = async (request: Request) => {
    const userId = requireUser(request, sessionSecret);
    const workspaceId = requireWorkspaceIdFromQuery(request);
    await requireRole(store, workspaceId, userId, "viewer");
    return userContext(workspaceId, userId);
  };
  return {
    get: async (request: Request, jobId: string): Promise<Response> => {
      try {
        const job = await getJob(store, await requireContext(request), jobId);
        if (!job) throw new RuleStoreError("NOT_FOUND", 404);
        return Response.json(job);
      } catch (error) { return jsonError(error); }
    },
    listProject: async (request: Request, projectId: string): Promise<Response> => {
      try {
        const url = new URL(request.url), type = url.searchParams.get("type"), status = url.searchParams.get("status");
        if (type && !ANALYSIS_JOB_TYPES.includes(type as typeof ANALYSIS_JOB_TYPES[number])) throw new RuleStoreError("INVALID_JOB_TYPE", 422);
        if (status && !(["queued", "running", "done", "failed", "dead"] as AnalysisJobStatus[]).includes(status as AnalysisJobStatus)) throw new RuleStoreError("INVALID_JOB_STATUS", 422);
        const jobs = await listProjectJobs(store, await requireContext(request), projectId, { type: type as AnalysisJobType | undefined, status: status as AnalysisJobStatus | undefined, limit: 50 });
        return Response.json({ jobs });
      } catch (error) { return jsonError(error); }
    },
  };
}
export function createDriftHandlers(service: DriftService, sessionSecret: string) {
  const requireWorkspace = (request: Request, body?: Record<string, unknown>) => body?.ownerWorkspaceId !== undefined && body.ownerWorkspaceId !== null ? requireWorkspaceIdFromBody(body) : requireWorkspaceIdFromQuery(request);
  return {
    trigger: async (request: Request, projectId: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.trigger(requireWorkspace(request, body), mutationUser(request, sessionSecret), projectId), { status: 202 }); } catch (e) { return jsonError(e); } },
    list: async (request: Request) => { try { return Response.json({ driftFindings: await service.list(requireWorkspace(request), sessionUser(request, sessionSecret)) }); } catch (e) { return jsonError(e); } },
    propose: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json().catch(() => ({})) as Record<string, unknown>; return Response.json(await service.propose(requireWorkspace(request, body), mutationUser(request, sessionSecret), id, body.requestId), { status: 202 }); } catch (e) { return jsonError(e); } },
    triage: async (request: Request, id: string, action: "accept" | "dismiss" | "reopen" | "untriage") => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json().catch(() => ({})) as Record<string, unknown>; return Response.json(await service.triage(requireWorkspace(request, body), mutationUser(request, sessionSecret), id, action, body.dismissReason)); } catch (e) { return jsonError(e); } },
  };
}
export function createUserPreferencesHandlers(preferences: UserPreferencesService, sessionSecret: string) {
  return {
    get: async (request: Request): Promise<Response> => { try { return Response.json(await preferences.get(requireUser(request, sessionSecret))); } catch (error) { return jsonError(error); } },
    patch: async (request: Request): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const userId = requireMutationUser(request, sessionSecret), body = await request.json() as Record<string, unknown>; return Response.json(await preferences.update(userId, body)); } catch (error) { return jsonError(error); } },
  };
}
export function createGitHubAppHandlers(githubApp: GitHubAppService, sessionSecret: string, webhookSecret: string) {
  return {
    webhook: (request: Request): Promise<Response> => githubApp.receiveWebhook(request, webhookSecret),
    setup: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const publicUrl = process.env.RULEBRANCH_PUBLIC_URL ?? url.toString();
      const userId = sessionUser(request, sessionSecret);
      if (!userId) return Response.redirect(new URL(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, publicUrl), 302);
      try {
        rejectJudgeDemoMutation(userId);
        const id = url.searchParams.get("installation_id");
        if (!id) throw new RuleStoreError("MISSING_INSTALLATION_ID", 422);
        const result = await githubApp.setup(userId, id, url.searchParams.get("setup_action"));
        return Response.redirect(new URL(`/w/${encodeURIComponent(result.workspaceId)}/projects/new?installation=${encodeURIComponent(result.installationId)}`, publicUrl), 302);
      } catch (error) {
        const code = isRuleStoreError(error) ? error.code : "INTERNAL_ERROR";
        console.error(JSON.stringify({ severity: "ERROR", message: "github.setup.failed", error: error instanceof Error ? error.message : "unknown", code }));
        return Response.redirect(new URL(`/install/error?code=${encodeURIComponent(code)}`, publicUrl), 302);
      }
    },
    installations: async (request: Request): Promise<Response> => { try { const userId = requireUser(request, sessionSecret), workspaceId = requireWorkspaceIdFromQuery(request); await requireRole(githubApp.store, workspaceId, userId, "viewer"); const installations = await githubApp.store.list(userContext(workspaceId, userId), "installations", { status: "active" }); return Response.json({ installations: installations.map(({ id, githubInstallationId, accountType, accountLogin, repositorySelection, status, installedAt }) => ({ id, githubInstallationId, accountType, accountLogin, repositorySelection, status, installedAt })) }); } catch (error) { return jsonError(error); } },
    repositories: async (request: Request, installationId: string): Promise<Response> => { try { const userId = requireUser(request, sessionSecret); const installation = (await githubApp.store.findServerDocuments("installations", { githubInstallationId: installationId }))[0]; if (!installation || installation.status !== "active" || installation.deletedAt || typeof installation.ownerWorkspaceId !== "string") throw new RuleStoreError("NOT_FOUND", 404); await requireRole(githubApp.store, installation.ownerWorkspaceId, userId, "viewer"); return Response.json({ repositories: await githubApp.repositories(installationId) }); } catch (error) { return jsonError(error); } },
  };
}
export function createWorkspaceInvitationHandlers(service: WorkspaceInvitationsService, sessionSecret: string) {
  return {
    create: async (request: Request, workspaceId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const id = requireMutationUser(request, sessionSecret), body = await request.json() as Record<string, unknown>; return Response.json(await service.createInvitation(workspaceId, id, { githubLogin: body.githubLogin as string, role: body.role as never, message: body.message as string | null | undefined })); } catch (error) { return jsonError(error); } },
    pending: async (request: Request, workspaceId: string): Promise<Response> => { try { if (new URL(request.url).searchParams.get("status") !== "pending") throw new RuleStoreError("INVALID_INVITATION_STATUS", 422); return Response.json({ invitations: await service.listPendingInvitations(workspaceId, requireUser(request, sessionSecret)) }); } catch (error) { return jsonError(error); } },
    mine: async (request: Request): Promise<Response> => { try { return Response.json({ invitations: await service.listMyInvitations(requireUser(request, sessionSecret)) }); } catch (error) { return jsonError(error); } },
    accept: async (request: Request, invitationId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { return Response.json(await service.acceptInvitation(requireMutationUser(request, sessionSecret), invitationId)); } catch (error) { return jsonError(error); } },
    decline: async (request: Request, invitationId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { return Response.json(await service.declineInvitation(requireMutationUser(request, sessionSecret), invitationId)); } catch (error) { return jsonError(error); } },
    revoke: async (request: Request, workspaceId: string, invitationId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { return Response.json(await service.revokeInvitation(workspaceId, requireMutationUser(request, sessionSecret), invitationId)); } catch (error) { return jsonError(error); } },
    members: async (request: Request, workspaceId: string): Promise<Response> => { try { return Response.json({ members: await service.listMembers(workspaceId, requireUser(request, sessionSecret)) }); } catch (error) { return jsonError(error); } },
    updateMember: async (request: Request, workspaceId: string, memberId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body: unknown = await request.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new RuleStoreError("INVALID_WORKSPACE_ROLE", 422); return Response.json(await service.updateMemberRole(workspaceId, requireMutationUser(request, sessionSecret), memberId, (body as Record<string, unknown>).role as never)); } catch (error) { return jsonError(error); } },
    removeMember: async (request: Request, workspaceId: string, memberId: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { return Response.json(await service.removeMember(workspaceId, requireMutationUser(request, sessionSecret), memberId)); } catch (error) { return jsonError(error); } },
  };
}
export function createProjectRepositoryHandlers(service: ProjectRepositoryService, sessionSecret: string) {
  return {
    createProject: async (request: Request): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.createProject(requireWorkspaceIdFromBody(body), requireMutationUser(request, sessionSecret), body as never), { status: 201 }); } catch (error) { return jsonError(error); } },
    listProjects: async (request: Request): Promise<Response> => { try { return Response.json({ projects: await service.listProjects(requireWorkspaceIdFromQuery(request), requireUser(request, sessionSecret)) }); } catch (error) { return jsonError(error); } },
    getProject: async (request: Request, id: string): Promise<Response> => { try { return Response.json(await service.getProject(requireWorkspaceIdFromQuery(request), requireUser(request, sessionSecret), id)); } catch (error) { return jsonError(error); } },
    deleteProject: async (request: Request, id: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : requireWorkspaceIdFromBody(body); return Response.json({ project: await service.deleteProject(workspaceId, requireMutationUser(request, sessionSecret), id, body as never) }); } catch (error) { return jsonError(error); } },
    addRepository: async (request: Request): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.addRepository(requireWorkspaceIdFromBody(body), requireMutationUser(request, sessionSecret), body as never), { status: 201 }); } catch (error) { return jsonError(error); } },
    listRepositories: async (request: Request): Promise<Response> => { try { const url = new URL(request.url); return Response.json({ repositories: await service.listRepositories(requireWorkspaceIdFromQuery(request), requireUser(request, sessionSecret), url.searchParams.get("projectId") ?? undefined) }); } catch (error) { return jsonError(error); } },
    unlinkRepository: async (request: Request, id: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { return Response.json(await service.unlinkRepository(requireWorkspaceIdFromQuery(request), requireMutationUser(request, sessionSecret), id)); } catch (error) { return jsonError(error); } },
    recompile: async (request: Request, id: string): Promise<Response> => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; const idempotency = typeof body.requestId === "string" && body.requestId ? body.requestId : crypto.randomUUID(); return Response.json(await service.recompile(requireWorkspaceIdFromBody(body), requireMutationUser(request, sessionSecret), id, idempotency), { status: 202 }); } catch (error) { return jsonError(error); } },
    revisionPrs: async (request: Request): Promise<Response> => { try { const url = new URL(request.url); return Response.json({ revisionPrs: await service.listRevisionPrs(requireWorkspaceIdFromQuery(request), requireUser(request, sessionSecret), url.searchParams.get("repositoryId") ?? undefined) }); } catch (error) { return jsonError(error); } },
    compiledArtifacts: async (request: Request): Promise<Response> => { try { const url = new URL(request.url); return Response.json({ compiledArtifacts: await service.listCompiledArtifacts(requireWorkspaceIdFromQuery(request), requireUser(request, sessionSecret), url.searchParams.get("repositoryId") ?? undefined) }); } catch (error) { return jsonError(error); } },
  };
}
export function createRuleHandlers(service: RulesService, sessionSecret: string) {
  const user = (request: Request) => sessionUser(request, sessionSecret);
  const mutationActor = (request: Request) => mutationUser(request, sessionSecret);
  return {
    create: async (request: Request) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.createRule(requireWorkspaceIdFromBody(body), mutationActor(request), body as never), { status: 201 }); } catch (error) { return jsonError(error); } },
    list: async (request: Request) => { try { return Response.json({ rules: await service.listRules(requireWorkspaceIdFromQuery(request), user(request)) }); } catch (error) { return jsonError(error); } },
    listProject: async (request: Request, projectId: string) => { try { const url = new URL(request.url); return Response.json({ rules: await service.listProjectRules(requireWorkspaceIdFromQuery(request), user(request), projectId, url.searchParams.get("status") ?? undefined) }); } catch (error) { return jsonError(error); } },
    get: async (request: Request, id: string) => { try { return Response.json(await service.getRule(requireWorkspaceIdFromQuery(request), user(request), id)); } catch (error) { return jsonError(error); } },
    patch: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; const { ownerWorkspaceId: _workspaceId, patch, ...metadata } = body; return Response.json(await service.updateRuleMetadata(requireWorkspaceIdFromBody(body), mutationActor(request), id, (patch as Record<string, unknown> | undefined) ?? metadata)); } catch (error) { return jsonError(error); } },
    createVersion: async (request: Request) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; if (typeof body.ruleId !== "string") throw new RuleStoreError("INVALID_RULE_ID", 422); return Response.json(await service.createRuleVersion(requireWorkspaceIdFromBody(body), mutationActor(request), body.ruleId, body as never), { status: 201 }); } catch (error) { return jsonError(error); } },
    listVersions: async (request: Request, ruleId?: string) => { try { const status = new URL(request.url).searchParams.get("status") ?? undefined; return Response.json({ ruleVersions: await service.listRuleVersions(requireWorkspaceIdFromQuery(request), user(request), ruleId, status) }); } catch (error) { return jsonError(error); } },
    approveVersion: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.approveRuleVersion(requireWorkspaceIdFromBody(body), mutationActor(request), id, { comment: typeof body.comment === "string" ? body.comment : undefined })); } catch (error) { return jsonError(error); } },
    rejectVersion: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.rejectRuleVersion(requireWorkspaceIdFromBody(body), mutationActor(request), id, body.reason)); } catch (error) { return jsonError(error); } },
    withdrawVersion: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.withdrawRuleVersion(requireWorkspaceIdFromBody(body), mutationActor(request), id)); } catch (error) { return jsonError(error); } },
    publicationState: async (request: Request, id: string) => { try { return Response.json(await service.getPublicationState(requireWorkspaceIdFromQuery(request), user(request), id)); } catch (error) { return jsonError(error); } },
    status: async (request: Request, id: string) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; return Response.json(await service.updateRuleStatus(requireWorkspaceIdFromBody(body), mutationActor(request), id, body.status, body)); } catch (error) { return jsonError(error); } },
    decisionMemories: async (request: Request) => { try { return Response.json({ decisionMemories: await service.listDecisionMemories(requireWorkspaceIdFromQuery(request), user(request)) }); } catch (error) { return jsonError(error); } },
    createRelation: async (request: Request) => { const blocked = requireRequestedWith(request); if (blocked) return blocked; try { const body = await request.json() as Record<string, unknown>; if (typeof body.childRuleId !== "string" || typeof body.parentRuleId !== "string") throw new RuleStoreError("INVALID_RULE_ID", 422); return Response.json(await service.createRelation(requireWorkspaceIdFromBody(body), mutationActor(request), body as never), { status: 201 }); } catch (error) { return jsonError(error); } },
    listRelations: async (request: Request) => { try { return Response.json({ ruleRelations: await service.listRelations(requireWorkspaceIdFromQuery(request), user(request)) }); } catch (error) { return jsonError(error); } },
  };
}

/** Read-only audit endpoint; admin authorization is enforced again by the service. */
export function createAuditLogHandlers(store: FirestoreRuleStore, sessionSecret: string) {
  return { list: async (request: Request): Promise<Response> => {
    try {
      const userId = requireUser(request, sessionSecret);
      const url = new URL(request.url);
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) throw new RuleStoreError("INVALID_QUERY_LIMIT", 422);
      const result = await listAuditLogs(store, requireWorkspaceIdFromQuery(request), userId, {
        limit: rawLimit === null ? undefined : Number(rawLimit), cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) { return jsonError(error); }
  } };
}
