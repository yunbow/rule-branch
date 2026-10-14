import { NextResponse, type NextRequest } from "next/server.js";

export function proxy(request: NextRequest): NextResponse {
  const requestHeaders = new Headers(request.headers);
  // Always overwrite caller input. Protected Server Components use only this
  // proxy-authored relative target after their normal session/user validation.
  requestHeaders.set("x-rulebranch-request-target", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/w/:path*", "/invitations", "/settings"],
};
