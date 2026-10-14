import { createDriftHandlers } from "../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> { const runtime = getRuntime(); if (!runtime.drift) throw new Error("Drift runtime is not configured"); return createDriftHandlers(runtime.drift, runtime.sessionSecret).propose(request, (await context.params).id); }
