import { createPurgeHandlers, rejectingOidcVerifier } from "../../../../shared/purge-api.ts";
import { getRuntime } from "../../../../shared/runtime.ts";

export async function POST(request: Request): Promise<Response> {
  const runtime = getRuntime();
  if (!runtime.store) throw new Error("Purge runtime is not configured");
  return createPurgeHandlers(runtime.store, runtime.schedulerOidcVerifier ?? rejectingOidcVerifier, runtime.schedulerAudience ?? "", runtime.sessionSecret).scan(request);
}
