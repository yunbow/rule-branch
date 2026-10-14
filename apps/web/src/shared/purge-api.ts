import { createPublicKey, verify as verifySignature } from "node:crypto";
import { verifySession } from "./auth.ts";
import { log } from "./logger.ts";
import { isRuleStoreError, RuleStoreError, type DocumentData, type FirestoreRuleStore, type RuleStoreContext } from "./rulestore.ts";
import { userActor, userContext } from "./service-context.ts";
import { requireRequestedWith } from "./request-security.ts";
import { rejectJudgeDemoMutation } from "./demo-session.ts";

export interface OidcVerifier { verify(token: string, audience: string): Promise<boolean> | boolean; }
export const rejectingOidcVerifier: OidcVerifier = { verify: () => false };
/** Verifies the Cloud Scheduler service-account ID token without trusting headers.
 * Key discovery happens only for an authenticated request, never at module load.
 * A valid Google-signed, correct-audience token is not enough on its own: any GCP
 * identity able to mint an ID token can choose an arbitrary audience, so the token
 * must also assert it was minted for our specific scheduler service account. */
export class GoogleOidcVerifier implements OidcVerifier {
  private readonly expectedServiceAccountEmail: string;
  constructor(expectedServiceAccountEmail: string) { this.expectedServiceAccountEmail = expectedServiceAccountEmail; }
  async verify(token: string, audience: string): Promise<boolean> {
    try { const [encodedHeader, encodedPayload, signature] = token.split("."); if (!encodedHeader || !encodedPayload || !signature) return false;
      const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as { alg?: string; kid?: string }, claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as { aud?: string; iss?: string; exp?: number; email?: string; email_verified?: boolean };
      if (header.alg !== "RS256" || !header.kid || claims.aud !== audience || !["accounts.google.com", "https://accounts.google.com"].includes(String(claims.iss)) || !claims.exp || claims.exp <= Date.now() / 1000) return false;
      if (claims.email !== this.expectedServiceAccountEmail || claims.email_verified !== true) return false;
      const keys = await (await fetch("https://www.googleapis.com/oauth2/v3/certs")).json() as { keys?: Array<Record<string, string>> }; const key = keys.keys?.find((item) => item.kid === header.kid); if (!key) return false;
      return verifySignature("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key, format: "jwk" } as Parameters<typeof createPublicKey>[0]), Buffer.from(signature, "base64url"));
    } catch { return false; }
  }
}

/** Internal Scheduler endpoint.  Production injects a Google JWT verifier at bootstrap;
 * the default is fail-closed so this route can never become a public job submitter. */
export function createPurgeHandlers(store: FirestoreRuleStore, verifier: OidcVerifier, audience: string, sessionSecret: string) {
  const bearer = (request: Request) => { const value = request.headers.get("authorization") ?? ""; return value.startsWith("Bearer ") ? value.slice(7) : ""; };
  const memberRole = async (workspaceId: string, userId: string) => (await store.findServerDocuments("workspace_members", { workspaceId, userId }))[0]?.role;
  return {
    scan: async (request: Request): Promise<Response> => {
      const token = bearer(request); if (!token) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      if (!await verifier.verify(token, audience)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      const now = new Date().toISOString(), installations = await store.findServerDocuments("installations", { status: "deleted" }); let queued = 0;
      for (const installation of installations) if (typeof installation.ownerWorkspaceId === "string" && String(installation.purgeScheduledAt ?? "") <= now) {
        const ctx: RuleStoreContext = { workspaceId: installation.ownerWorkspaceId, actorUserId: null, actorKind: "system" };
        const result = await store.createAnalysisJob(ctx, { type: "purge", payload: { workspaceId: installation.ownerWorkspaceId }, idempotencyKey: `purge:${installation.ownerWorkspaceId}`, requestId: `purge-scan:${installation.ownerWorkspaceId}` }); if (result.created) queued += 1;
      }
      return Response.json({ queued });
    },
    /** Re-dispatches "queued" analysis_jobs that are older than staleAfterMs (a committed
     * job whose Cloud Tasks enqueue failed, e.g. createProject's job creation call after
     * the project transaction already committed). Safe to run repeatedly: the Cloud Tasks
     * task name is derived from job.id, so a still-outstanding task collides harmlessly. */
    reconcileJobs: async (request: Request, redispatch: (job: DocumentData) => Promise<void>, staleAfterMs = 5 * 60 * 1000): Promise<Response> => {
      const token = bearer(request); if (!token) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      if (!await verifier.verify(token, audience)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      await store.reconcilePendingCompilations();
      let redispatched = 0, failed = 0;
      // Recover a project committed before its bootstrap job was recorded.
      // Queued-job reconciliation alone cannot see a job that never existed.
      const projects = await store.findServerDocuments("projects", { bootstrapPending: true });
      for (const project of projects) {
        if (typeof project.id !== "string" || typeof project.ownerWorkspaceId !== "string"
          || project.status !== "active" || project.deletedAt) continue;
        const ctx: RuleStoreContext = { workspaceId: project.ownerWorkspaceId, actorUserId: null, actorKind: "system" };
        try {
          await store.createAnalysisJob(ctx, { type: "bootstrap", projectId: project.id, payload: {},
            idempotencyKey: `bootstrap:${project.id}`, requestId: `bootstrap-reconcile:${project.id}` });
          await store.markProjectBootstrapQueued(ctx, project.id);
        } catch (error) {
          failed += 1;
          log("ERROR", "bootstrap intent reconcile failed", { projectId: project.id, error: String(error) });
        }
      }
      const threshold = Date.now() - staleAfterMs; const jobs = await store.findServerDocuments("analysis_jobs", { status: "queued" });
      // One job's redispatch failure must not starve the rest of the batch: a
      // persistently-broken job would otherwise block every job after it on every
      // 5-minute run. The next scan retries a still-failing job on its own.
      for (const job of jobs) if (Date.parse(String(job.createdAt ?? "")) <= threshold) {
        if (job.type !== "purge" && (typeof job.projectId !== "string" || !(await store.get({ workspaceId: String(job.ownerWorkspaceId), actorUserId: null, actorKind: "system" }, "projects", job.projectId)))) continue;
        try { await redispatch(job); redispatched += 1; }
        catch (error) { failed += 1; log("ERROR", "job reconcile redispatch failed", { jobId: job.id, error: String(error) }); }
      }
      return Response.json({ redispatched, failed });
    },
    subjectRequest: async (request: Request): Promise<Response> => {
      const blocked = requireRequestedWith(request); if (blocked) return blocked;
      const session = verifySession(request.headers.get("cookie")?.match(/(?:^|; )rulebranch_session=([^;]+)/)?.[1], sessionSecret); if (!session) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      try { rejectJudgeDemoMutation(session.userId); const body = await request.json() as Record<string, unknown>, userId = session.userId, workspaceId = String(body.ownerWorkspaceId ?? ""), requestId = String(body.requestId ?? "");
        // Account deletion is self-service only (P0 fix): a Workspace admin can remove a
        // member's membership, never another person's global RuleBranch account. Accepting
        // an admin-supplied target userId here previously let any workspace admin delete an
        // arbitrary user's account with no membership check on the target at all.
        if (typeof body.userId === "string" && body.userId !== session.userId) throw new RuleStoreError("FORBIDDEN", 403, { reason: "account deletion is self-service only" });
        if (!workspaceId || !requestId) throw new RuleStoreError("INVALID_REQUEST", 422);
        if (!(await memberRole(workspaceId, session.userId))) throw new RuleStoreError("FORBIDDEN", 403);
        // Account deletion removes this user's membership in every Workspace they
        // belong to (Worker's _subject), not just the selected one, and does so
        // directly rather than through updateMemberRole/removeMember's own
        // LAST_OWNER_REQUIRED guard. Without this preflight, a sole Organization
        // owner deleting their account would silently leave that Organization (and
        // its Rules/Projects) ownerless rather than being told to transfer ownership.
        for (const membership of await store.findServerDocuments("workspace_members", { userId: session.userId })) {
          if (membership.role !== "owner") continue;
          const workspace = (await store.findServerDocuments("workspaces", { id: membership.workspaceId }))[0];
          if (!workspace || workspace.kind !== "organization") continue;
          const owners = await store.findServerDocuments("workspace_members", { workspaceId: membership.workspaceId, role: "owner" });
          if (owners.length <= 1) throw new RuleStoreError("LAST_OWNER_REQUIRED", 422, { workspaceId: membership.workspaceId });
        }
        const ctx = userContext(workspaceId, session.userId);
        const result = await store.createAnalysisJob(ctx, { type: "purge", payload: { subject: userId }, idempotencyKey: `purge:subject:${userId}:${requestId}`, requestId });
        await store.appendAuditLog(ctx, { actor: userActor(session.userId), action: "data.subject_request", targetType: "users", targetId: userId, requestId, after: { jobId: result.job.id } });
        return Response.json({ jobId: result.job.id }, { status: 202 });
      } catch (error) { return isRuleStoreError(error) ? Response.json({ error: error.code }, { status: error.status }) : Response.json({ error: "INTERNAL_ERROR" }, { status: 500 }); }
    },
  };
}
