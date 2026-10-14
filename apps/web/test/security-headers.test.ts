import assert from "node:assert/strict";
import test from "node:test";
import nextConfig, { securityHeaders } from "../next.config.ts";

test("all routes receive the baseline browser security headers", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const routes = await nextConfig.headers!();
  assert.equal(routes.length, 1); assert.equal(routes[0]!.source, "/:path*");
  const headers = new Map(securityHeaders.map(({ key, value }) => [key, value]));
  assert.match(headers.get("Content-Security-Policy")!, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
  assert.match(headers.get("Content-Security-Policy")!, /(?:^|; )object-src 'none'(?:;|$)/);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
});
