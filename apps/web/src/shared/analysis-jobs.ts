/** Cloud Tasks boundary and API-shaped helpers.  The client is injected so this
 * module never contacts GCP during import or unit tests. */
import { sha256HexString, type AnalysisJob, type AnalysisJobStatus, type AnalysisJobType, type CreateAnalysisJobInput, type FirestoreRuleStore, type RuleStoreContext } from "./rulestore.ts";

export interface CloudTaskRequest { name: string; httpRequest: { url: string; httpMethod: "POST"; headers: Record<string, string>; body: Uint8Array; oidcToken?: { serviceAccountEmail: string; audience: string } }; }
export interface CloudTasksClientLike { createTask(request: { parent: string; task: CloudTaskRequest }): Promise<unknown>; }
export function isAlreadyExists(error: unknown): boolean { const value = error as { code?: unknown; message?: unknown }; return value?.code === 6 || value?.code === "ALREADY_EXISTS" || /ALREADY_EXISTS/i.test(String(value?.message ?? "")); }
export async function enqueueAnalysisJob(client: CloudTasksClientLike, parent: string, taskUrl: string, audience: string, serviceAccountEmail: string, job: AnalysisJob): Promise<void> {
  // Keyed by job.id (always unique per document), not job.idempotencyKey: a "dead" job
  // releases its idempotency key for reuse by a brand-new job, and that new job would
  // otherwise collide with the old job's already-consumed Cloud Tasks task name.
  const hash = sha256HexString(job.id); const task: CloudTaskRequest = { name: `${parent}/tasks/${hash}`, httpRequest: { url: taskUrl, httpMethod: "POST", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ jobId: job.id, workspaceId: job.ownerWorkspaceId })), oidcToken: { serviceAccountEmail, audience } } };
  try { await client.createTask({ parent, task }); } catch (error) { if (!isAlreadyExists(error)) throw error; }
}
export async function submitAnalysisJob(store: FirestoreRuleStore, ctx: RuleStoreContext, input: CreateAnalysisJobInput): Promise<{ status: 202; jobId: string }> { const result = await store.createAnalysisJob(ctx, input); return { status: 202, jobId: result.job.id }; }
export interface ListProjectJobsOptions { type?: AnalysisJobType; status?: AnalysisJobStatus; limit?: number; startAfter?: string; }
export async function listProjectJobs(store: FirestoreRuleStore, ctx: RuleStoreContext, projectId: string, options: ListProjectJobsOptions = {}): Promise<AnalysisJob[]> {
  const constraints = [
    { field: "projectId", op: "==" as const, value: projectId },
    ...(options.type ? [{ field: "type", op: "==" as const, value: options.type }] : []),
    ...(options.status ? [{ field: "status", op: "==" as const, value: options.status }] : []),
  ];
  return await store.listQuery(ctx, "analysis_jobs", constraints, { orderBy: { field: "createdAt", direction: "desc" }, limit: options.limit ?? 50, startAfter: options.startAfter }) as AnalysisJob[];
}
export async function getJob(store: FirestoreRuleStore, ctx: RuleStoreContext, jobId: string): Promise<AnalysisJob | null> { return await store.get(ctx, "analysis_jobs", jobId) as AnalysisJob | null; }
