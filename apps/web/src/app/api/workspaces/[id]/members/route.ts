import { createWorkspaceInvitationHandlers } from "../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> { const runtime = getRuntime(); if (!runtime.workspaceInvitations) throw new Error("Workspace invitation runtime is not configured"); return createWorkspaceInvitationHandlers(runtime.workspaceInvitations, runtime.sessionSecret).members(request, (await context.params).id); }
