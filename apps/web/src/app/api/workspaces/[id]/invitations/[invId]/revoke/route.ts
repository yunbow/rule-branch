import { createWorkspaceInvitationHandlers } from "../../../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../../../shared/runtime.ts";
export async function POST(request: Request, context: { params: Promise<{ id: string; invId: string }> }): Promise<Response> { const runtime = getRuntime(); if (!runtime.workspaceInvitations) throw new Error("Workspace invitation runtime is not configured"); const p = await context.params; return createWorkspaceInvitationHandlers(runtime.workspaceInvitations, runtime.sessionSecret).revoke(request, p.id, p.invId); }
