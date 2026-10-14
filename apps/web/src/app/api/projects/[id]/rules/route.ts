import { createRuleHandlers } from "../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const runtime = getRuntime(); if (!runtime.rules) throw new Error("Rules runtime is not configured");
  return createRuleHandlers(runtime.rules, runtime.sessionSecret).listProject(request, (await context.params).id);
}
