import { createRuleHandlers } from "../../../shared/http-api.ts";
import { getRuntime } from "../../../shared/runtime.ts";
export async function POST(request: Request): Promise<Response> { const runtime = getRuntime(); if (!runtime.rules) throw new Error("Rules runtime is not configured"); return createRuleHandlers(runtime.rules, runtime.sessionSecret).createVersion(request); }
export async function GET(request: Request): Promise<Response> { const runtime = getRuntime(); if (!runtime.rules) throw new Error("Rules runtime is not configured"); return createRuleHandlers(runtime.rules, runtime.sessionSecret).listVersions(request); }
