import { createPurgeHandlers, rejectingOidcVerifier } from "../../../../shared/purge-api.ts";
import type { AnalysisJob, DocumentData } from "../../../../shared/rulestore.ts";
import { getRuntime } from "../../../../shared/runtime.ts";

export async function POST(request: Request): Promise<Response> {
  const runtime = getRuntime();
  if (!runtime.store) throw new Error("Reconcile runtime is not configured");
  const store = runtime.store;
  const dispatch = runtime.redispatchAnalysisJob;
  if (!dispatch) return Response.json({ error: "JOB_DISPATCH_NOT_CONFIGURED" }, { status: 503 });
  const redispatch = (job: DocumentData) => dispatch(job as unknown as AnalysisJob);
  return createPurgeHandlers(store, runtime.schedulerOidcVerifier ?? rejectingOidcVerifier, runtime.schedulerAudience ?? "", runtime.sessionSecret).reconcileJobs(request, redispatch);
}
