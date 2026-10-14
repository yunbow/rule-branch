import { createApprovalScanHandler } from "../../../../shared/approval-api.ts";
import { getRuntime } from "../../../../shared/runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request): Promise<Response> {
  const services = getRuntime();
  return createApprovalScanHandler(services.automaticApproval, services.schedulerOidcVerifier, services.schedulerAudience)(request);
}
