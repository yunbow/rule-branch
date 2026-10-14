/** Start GitHub's authorization-code flow. Credentials are intentionally supplied only
 * by deployment configuration; tests exercise the callback with an injected client. */
import { randomBytes } from "node:crypto";
import { safeRelativeUrl } from "../../../../shared/auth-navigation.ts";

const oauthCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; Path=/api/auth/github; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}; Max-Age=${maxAge}`;

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const next = safeRelativeUrl(requestUrl.searchParams.get("next"));
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    const loginUrl = new URL("/login", requestUrl);
    loginUrl.searchParams.set("error", "GITHUB_OAUTH_NOT_CONFIGURED");
    if (next) loginUrl.searchParams.set("next", next);
    return Response.redirect(loginUrl, 302);
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  const publicUrl = process.env.RULEBRANCH_PUBLIC_URL ?? request.url;
  url.searchParams.set("redirect_uri", new URL("/api/auth/github/callback", publicUrl).toString());
  url.searchParams.set("scope", "read:user user:email");

  const state = randomBytes(24).toString("base64url");
  url.searchParams.set("state", state);

  const response = new Response(null, { status: 302, headers: { Location: url.toString() } });
  response.headers.append("Set-Cookie", oauthCookie("rulebranch_oauth_state", state, 600));
  response.headers.append(
    "Set-Cookie",
    oauthCookie("rulebranch_oauth_next", next ? encodeURIComponent(next) : "", next ? 600 : 0),
  );
  return response;
}
