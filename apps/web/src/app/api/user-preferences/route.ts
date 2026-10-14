import { createUserPreferencesHandlers } from "../../../shared/http-api.ts";
import { getRuntime } from "../../../shared/runtime.ts";
export async function GET(request: Request): Promise<Response> { const runtime = getRuntime(); return createUserPreferencesHandlers(runtime.preferences, runtime.sessionSecret).get(request); }
export async function PATCH(request: Request): Promise<Response> { const runtime = getRuntime(); return createUserPreferencesHandlers(runtime.preferences, runtime.sessionSecret).patch(request); }
