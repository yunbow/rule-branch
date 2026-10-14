export class ApiError extends Error { constructor(public code: string, public status: number, public details?: unknown) { super(code); this.name = "ApiError"; } }
export async function apiFetch<T>(path: string, options: { method?: string; body?: Record<string, unknown>; workspaceId?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? "GET"; const writing = /^(POST|PATCH|PUT|DELETE)$/i.test(method); const url = new URL(path, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  if (!writing && options.workspaceId) url.searchParams.set("workspaceId", options.workspaceId);
  const body = writing && options.workspaceId ? { ...options.body, ownerWorkspaceId: options.workspaceId } : options.body;
  const response = await fetch(url.pathname + url.search, { method, headers: { Accept: "application/json", ...(writing ? { "Content-Type": "application/json", "X-Requested-With": "RuleBranch" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", signal: options.signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string; details?: unknown }; throw new ApiError(data.error ?? "INTERNAL_ERROR", response.status, data.details); }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
