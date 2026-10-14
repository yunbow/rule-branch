import { createJudgeDemoLoginHandlers } from "../../../../shared/demo-auth.ts";
import { getRuntime } from "../../../../shared/runtime.ts";

export async function POST(request: Request): Promise<Response> {
  const runtime = getRuntime();
  if (!runtime.store) return new Response(null, { status: 404 });
  return createJudgeDemoLoginHandlers(runtime.store, runtime.sessionSecret).login(request);
}
