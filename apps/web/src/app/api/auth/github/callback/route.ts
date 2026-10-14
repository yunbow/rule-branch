import { createAuthHandlers } from "../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
export async function GET(request: Request): Promise<Response> { const runtime = getRuntime(); return createAuthHandlers(runtime.auth, runtime.sessionSecret).callback(request); }
