import { createProjectRepositoryHandlers } from "../../../shared/http-api.ts";
import { getRuntime } from "../../../shared/runtime.ts";
export async function POST(request: Request): Promise<Response> { const runtime = getRuntime(); if (!runtime.projectRepositories) throw new Error("Project repository runtime is not configured"); return createProjectRepositoryHandlers(runtime.projectRepositories, runtime.sessionSecret).addRepository(request); }
export async function GET(request: Request): Promise<Response> { const runtime = getRuntime(); if (!runtime.projectRepositories) throw new Error("Project repository runtime is not configured"); return createProjectRepositoryHandlers(runtime.projectRepositories, runtime.sessionSecret).listRepositories(request); }
