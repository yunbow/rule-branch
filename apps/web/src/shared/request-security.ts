/** CSRF defence for browser-initiated mutations. External machine-to-machine
 * endpoints authenticate their requests independently and deliberately skip it. */
export function requireRequestedWith(request: Request): Response | null {
  if (request.headers.get("x-requested-with") !== "RuleBranch") {
    return Response.json({ error: "MISSING_REQUESTED_WITH_HEADER" }, { status: 403 });
  }

  // The custom header makes a cross-origin browser request non-simple, but it is
  // not itself proof of origin: a compromised sibling subdomain can send it.  When
  // browsers provide Origin or Fetch Metadata, bind the mutation to this origin.
  // Header-less non-browser clients remain supported for operational endpoints
  // which use the same handlers in tests and local development.
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      // Cloud Run forwards the original host to the application, but Request.url
      // can still describe its internal listener.  Use the configured canonical
      // public URL for browser-origin checks when it is available.
      const expectedOrigin = new URL(process.env.RULEBRANCH_PUBLIC_URL ?? request.url).origin;
      if (new URL(origin).origin !== expectedOrigin) {
        return Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
  }
  return null;
}
