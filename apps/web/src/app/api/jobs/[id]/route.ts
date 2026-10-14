import { createJobHandlers } from "../../../../shared/http-api.ts";
import { getRuntime } from "../../../../shared/runtime.ts";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const runtime = getRuntime();
  if (!runtime.store) throw new Error("Rule store runtime is not configured");
  return createJobHandlers(runtime.store, runtime.sessionSecret).get(request, (await context.params).id);
}
