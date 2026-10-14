import { createDriftHandlers } from "../../../shared/http-api.ts";
import { getRuntime } from "../../../shared/runtime.ts";
export async function GET(request: Request): Promise<Response> { const r = getRuntime(); if (!r.drift) throw new Error("Drift runtime is not configured"); return createDriftHandlers(r.drift, r.sessionSecret).list(request); }
