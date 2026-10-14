const SAFE_URL_BASE = "https://rulebranch.invalid";
const ENCODED_BACKSLASH_OR_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

/** Return a canonical app-relative URL, or null for ambiguous/external input. */
export function safeRelativeUrl(value: string | null | undefined): string | null {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(value) || ENCODED_BACKSLASH_OR_CONTROL.test(value)) return null;
  // Reject a slash/backslash hidden at the authority boundary. Query escapes are
  // retained verbatim and are never decoded as part of this check.
  if (/^\/%(?:2f|5c)/i.test(value)) return null;
  try {
    const parsed = new URL(value, SAFE_URL_BASE);
    if (parsed.origin !== SAFE_URL_BASE) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function unauthenticatedLoginRedirect(requestUrl: URL): Response {
  const next = safeRelativeUrl(`${requestUrl.pathname}${requestUrl.search}`);
  const search = new URLSearchParams();
  if (next) search.set("next", next);
  return new Response(null, {
    status: 307,
    headers: { Location: `/login${search.size ? `?${search}` : ""}` },
  });
}

export function loginPathForContinuation(value: string | null | undefined): string {
  const next = safeRelativeUrl(value);
  if (!next) return "/login";
  const search = new URLSearchParams({ next });
  return `/login?${search}`;
}
