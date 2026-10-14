import type { AutomaticApprovalService } from "./automatic-approval.ts";

export interface ApprovalOidcVerifier { verify(token: string, audience: string): boolean | Promise<boolean>; }
export function createApprovalScanHandler(service: Pick<AutomaticApprovalService, "scan"> | undefined, verifier: ApprovalOidcVerifier | undefined, audience: string | undefined) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !authorization.slice(7)) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    if (!verifier || !audience) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    try {
      if (!await verifier.verify(authorization.slice(7), audience)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
      // The request body cannot select tenants, lower thresholds or inject a verdict.
      if (!service) return Response.json({ mode: "manual", reviewed: 0 });
      return Response.json(await service.scan());
    } catch { return Response.json({ error: "APPROVAL_SCAN_FAILED" }, { status: 503 }); }
  };
}
