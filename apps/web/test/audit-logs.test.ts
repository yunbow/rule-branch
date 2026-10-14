import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { createAuditLogHandlers } from "../src/shared/http-api.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "audit-tests";
function fixture() {
  const db = new InMemoryFirestore();
  db.put("workspaces/w", { id: "w", kind: "organization", status: "active" });
  for (const role of ["owner", "admin", "maintainer", "member", "viewer"]) {
    db.put(`unique_keys/workspace_member:w:${role}`, { targetId: role });
    db.put(`workspace_members/${role}`, { id: role, ownerWorkspaceId: "w", workspaceId: "w", userId: role, role });
  }
  for (const id of ["a", "b", "c"]) db.put(`audit_logs/${id}`, {
    id, ownerWorkspaceId: "w", occurredAt: "2026-10-10T00:00:00.000Z", actor: { kind: "user", id: "owner" },
    action: "rule.update", targetType: "rules", targetId: "rule", requestId: id, before: { title: "old" }, after: { title: "new" }, ip: "private-ip",
  });
  db.put("audit_logs/foreign", { id: "foreign", ownerWorkspaceId: "other", occurredAt: "2026-10-11T00:00:00Z", action: "secret" });
  return { db, handlers: createAuditLogHandlers(new FirestoreRuleStore(db), secret) };
}
function request(userId?: string, query = "workspaceId=w") {
  return new Request("https://test/api/audit-logs?" + query, { headers: userId ? { cookie: `rulebranch_session=${signSession({ userId, issuedAt: Date.now() }, secret)}` } : {} });
}
test("audit logs require authenticated admins and never read logs for denied users", async () => {
  const { db, handlers } = fixture();
  assert.equal((await handlers.list(request())).status, 401);
  for (const role of ["maintainer", "member", "viewer", "outsider"]) assert.equal((await handlers.list(request(role))).status, 403);
  assert.equal(db.queryCounts.get("audit_logs") ?? 0, 0);
  for (const role of ["owner", "admin"]) assert.equal((await handlers.list(request(role))).status, 200);
  assert.equal((await handlers.list(request("owner", "workspaceId=other"))).status, 403);
});
test("audit pagination preserves equal timestamps, tenant boundaries, and excludes IP", async () => {
  const { handlers } = fixture();
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const response = await handlers.list(request("owner", "workspaceId=w&limit=1" + (cursor ? "&cursor=" + cursor : "")));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const result = await response.json();
    assert.equal(result.entries.length, 1);
    assert.equal("ip" in result.entries[0], false);
    assert.equal("ownerWorkspaceId" in result.entries[0], false);
    ids.push(result.entries[0].id); cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["c", "b", "a"]);
});
test("audit reads reject invalid limits and cursors without disclosing another tenant", async () => {
  const { handlers } = fixture();
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=NaN", "cursor=foreign", "cursor=missing", "cursor=../secret", "cursor="]) {
    assert.equal((await handlers.list(request("owner", "workspaceId=w&" + query))).status, 422, query);
  }
  assert.equal((await handlers.list(request("owner", ""))).status, 422);
});
test("redacted audit payloads stay absent in the read response", async () => {
  const { db, handlers } = fixture();
  db.put("audit_logs/c", { id: "c", ownerWorkspaceId: "w", occurredAt: "2026-10-10T00:00:00.000Z", before: null, after: null, payloadRedactedAt: "2026-10-10" });
  const result = await (await handlers.list(request("admin"))).json();
  assert.equal(result.entries[0].payloadRedactedAt, "2026-10-10");
  assert.equal(result.entries[0].before, null); assert.equal(result.entries[0].after, null);
});
