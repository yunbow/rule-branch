import { createEvidenceHandlers } from "../../../shared/http-api.ts";
import { getRuntime } from "../../../shared/runtime.ts";
export async function GET(request: Request): Promise<Response> { const runtime = getRuntime(); if (!runtime.store) throw new Error("Store runtime is not configured"); return createEvidenceHandlers(runtime.store, runtime.sessionSecret).list(request); }
