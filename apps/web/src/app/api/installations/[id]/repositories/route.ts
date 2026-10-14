import { createGitHubAppHandlers } from "../../../../../shared/http-api.ts";
import { getRuntime } from "../../../../../shared/runtime.ts";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> { const runtime = getRuntime(); if (!runtime.githubApp || !runtime.githubWebhookSecret) throw new Error("GitHub App runtime is not configured"); return createGitHubAppHandlers(runtime.githubApp, runtime.sessionSecret, runtime.githubWebhookSecret).repositories(request, (await context.params).id); }
