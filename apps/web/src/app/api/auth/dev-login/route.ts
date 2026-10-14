import { createDevLoginHandlers } from "../../../../shared/http-api.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
export async function POST(request: Request): Promise<Response> { const runtime = getRuntime(); return createDevLoginHandlers(runtime.auth, runtime.sessionSecret).login(request); }
