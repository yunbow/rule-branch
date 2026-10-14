import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticApprovalService } from "../src/shared/automatic-approval.ts";
import { FirestoreApprovalRepository } from "../src/shared/firestore-approval-repository.ts";
import { createApprovalScanHandler } from "../src/shared/approval-api.ts";
import { contextDigest, decideApproval } from "../src/shared/approval-policy.ts";
import { database } from "./approval-memory-firestore.ts";
import { config, signals } from "./approval-fixture.ts";
const pointer = { workspaceId: "workspace", versionId: "proposal" };
const setup = () => { const db = database(); return { db, repository: new FirestoreApprovalRepository(db.asFirestore(), db.asStore()) }; };

test("auto approval atomically advances version, finding, memory and compilation outbox", async () => {
  const { db, repository } = setup();
  const result = await new AutomaticApprovalService(repository, { evaluate: async () => signals() }, config()).scan();
  assert.equal(result.autoApproved, 1); assert.equal(result.failed, 0);
  assert.equal(db.get("rules", "rule").currentVersionId, "proposal"); assert.equal(db.get("rules", "rule").status, "active");
  assert.equal(db.get("rule_versions", "old").status, "superseded");
  const approved = db.get("rule_versions", "proposal"); assert.equal(approved.status, "approved"); assert.equal(approved.approvedBy, null);
  assert.equal(approved.approvalReview.approvalActor.kind, "system"); assert.equal(approved.approvalReview.compilePending, false);
  assert.equal(db.get("drift_findings", "finding").status, "resolved");
  const savedMemories = [...db.docs.entries()]
    .filter(([key]) => key.startsWith("decision_memories/"))
    .map(([, memory]) => memory);
  assert.equal(savedMemories.length, 1);
  assert.equal(savedMemories[0]?.approvedRuleVersionId, "proposal");
  assert.equal(savedMemories[0]?.approvedRuleVersionNumber, 2);
  assert.equal(savedMemories[0]?.approvedChangeType, "clarify");
  assert.equal(savedMemories[0]?.approvalMode, "automatic");
  assert.equal([...db.docs.values()].filter((doc) => doc.action === "rule_version.auto_approve").length, 1);
  assert.equal(db.dispatches.size, 1); assert.equal(db.dispatches.get("compile:repo:proposal")!.payload.ruleVersionId, "proposal");
  assert.equal((await new AutomaticApprovalService(repository, { evaluate: async () => { throw Error("must not reevaluate"); } }, config()).scan()).autoApproved, 0);
});
test("protected rules never call Google; normal human approval remains available", async () => {
  const { db, repository } = setup(); db.get("rules", "rule").enforcement = "locked"; let calls = 0;
  const result = await new AutomaticApprovalService(repository, { evaluate: async () => { calls++; return signals(); } }, config()).scan();
  assert.equal(calls, 0); assert.equal(result.humanRequired, 1); assert.equal(db.get("rule_versions", "proposal").status, "proposed"); assert.equal(db.get("rules", "rule").currentVersionId, "old");
});
test("provider exceptions escalate without leaking raw errors or changing the current version", async () => {
  const { db, repository } = setup(); const result = await new AutomaticApprovalService(repository, { evaluate: async () => { throw Error("PRIVATE SOURCE CONTENT"); } }, config()).scan();
  assert.equal(result.humanRequired, 1); assert.equal(db.get("rules", "rule").currentVersionId, "old"); assert.ok(!JSON.stringify([...db.docs.values()]).includes("PRIVATE SOURCE CONTENT"));
});
for (const mutation of ["evidence", "new-rule", "consent", "proposal"]) test(`concurrent ${mutation} modification invalidates the evaluated snapshot`, async () => {
  const { db, repository } = setup(); await repository.claim(pointer, "evaluation", config()); const c = await repository.load(pointer), hash = contextDigest(c);
  if (mutation === "evidence") db.get("evidence", "evidence").excerpt = "changed";
  if (mutation === "new-rule") db.put("rules", { ...db.get("rules", "rule"), id: "another", title: "New conflicting rule" });
  if (mutation === "consent") db.get("workspaces", "workspace").settings.aiDataUsageConsent = false;
  if (mutation === "proposal") db.get("rule_versions", "proposal").content = "changed";
  assert.equal(await repository.complete(pointer, "evaluation", hash, decideApproval(c, config(), signals()), config()), "human_required");
  assert.deepEqual(db.get("rule_versions", "proposal").approvalReview.reasonCodes, ["CONTEXT_CHANGED"]);
});
test("human approval wins over an in-flight auto review", async () => {
  const { db, repository } = setup(); await repository.claim(pointer, "evaluation", config()); const c = await repository.load(pointer);
  Object.assign(db.get("rule_versions", "proposal"), { status: "approved", approvedBy: "human" });
  assert.equal(await repository.complete(pointer, "evaluation", contextDigest(c), decideApproval(c, config(), signals()), config()), "skipped");
  assert.equal(db.get("rule_versions", "proposal").approvedBy, "human");
});
test("leases prevent duplicate evaluation and crash recovery escalates", async () => {
  const { db, repository } = setup(); assert.equal(await repository.claim(pointer, "first", config()), true); assert.equal(await repository.claim(pointer, "second", config()), false);
  db.get("rule_versions", "proposal").approvalReview.leaseExpiresAt = new Date(0).toISOString();
  assert.equal(await repository.claim(pointer, "third", config()), false); assert.equal(db.get("rule_versions", "proposal").approvalReview.state, "human_required");
});
test("missing context never permits an automatic outcome even if one is supplied", async () => {
  const { db, repository } = setup(); await repository.claim(pointer, "evaluation", config());
  assert.equal(await repository.complete(pointer, "evaluation", null, { state: "auto_approved", wouldAutoApprove: true, reasonCodes: [], signals: signals() }, config()), "human_required");
  assert.equal(db.get("rules", "rule").currentVersionId, "old");
});
test("store rechecks protection even if caller supplies a forged automatic outcome", async () => {
  const { db, repository } = setup(); db.get("rules", "rule").enforcement = "locked"; await repository.claim(pointer, "evaluation", config()); const c = await repository.load(pointer);
  assert.equal(await repository.complete(pointer, "evaluation", contextDigest(c), { state: "auto_approved", wouldAutoApprove: true, reasonCodes: [], signals: signals() }, config()), "human_required");
});
test("durable compilation intent survives failed dispatch and retries idempotently", async () => {
  const { db, repository } = setup(); db.failDispatch = true; const service = new AutomaticApprovalService(repository, { evaluate: async () => signals() }, config());
  assert.equal((await service.scan()).autoApproved, 1); assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, true);
  db.failDispatch = false; await service.scan(); assert.equal(db.dispatches.size, 1); assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, false);
  await service.scan(); assert.equal(db.dispatches.size, 1);
});
test("unrelated open findings keep the rule stale", async () => {
  const { db, repository } = setup(); db.put("drift_findings", { id: "other", ownerWorkspaceId: "workspace", ruleId: "rule", status: "open" });
  assert.equal((await new AutomaticApprovalService(repository, { evaluate: async () => signals() }, config()).scan()).autoApproved, 1); assert.equal(db.get("rules", "rule").status, "stale");
});
test("tenant boundary is enforced independently of job arguments", async () => {
  const { db, repository } = setup(); db.get("rule_versions", "proposal").ownerWorkspaceId = "other";
  assert.equal(await repository.claim(pointer, "evaluation", config()), false); await assert.rejects(repository.load(pointer));
});
test("deleted projects are excluded from scans and cannot be claimed or completed", async () => {
  const first = setup(); delete first.db.get("rules", "rule").projectId; first.db.get("projects", "project").status = "archived"; first.db.get("projects", "project").deletedAt = new Date().toISOString();
  assert.deepEqual(await first.repository.listPending("workspace", 20), []);
  assert.equal(await first.repository.claim(pointer, "evaluation", config()), false);
  const second = setup(); assert.equal(await second.repository.claim(pointer, "evaluation", config()), true);
  const loaded = await second.repository.load(pointer); second.db.get("projects", "project").status = "archived"; second.db.get("projects", "project").deletedAt = new Date().toISOString();
  assert.equal(await second.repository.complete(pointer, "evaluation", contextDigest(loaded), decideApproval(loaded, config(), signals()), config()), "skipped");
  assert.equal(second.db.get("rules", "rule").currentVersionId, "old");
});
test("project deletion after claim skips before external evaluation", async () => {
  const { db, repository } = setup(); let calls = 0;
  const claim = repository.claim.bind(repository);
  repository.claim = async (...args) => { const claimed = await claim(...args); if (claimed) { db.get("projects", "project").status = "archived"; db.get("projects", "project").deletedAt = new Date().toISOString(); } return claimed; };
  const result = await new AutomaticApprovalService(repository, { evaluate: async () => { calls += 1; return signals(); } }, config()).scan();
  assert.equal(calls, 0); assert.equal(result.skipped, 1); assert.equal(result.autoApproved, 0);
  assert.equal(db.get("rules", "rule").currentVersionId, "old");
});
test("pending pagination advances only through returned candidates and handles empty batch joins", async () => {
  const { db, repository } = setup(), old = new Date(Date.now() - 600000).toISOString();
  db.get("rule_versions", "proposal").approvalReview = { state: "human_required" };
  for (const id of ["proposal-a", "proposal-b", "proposal-c"]) db.put("rule_versions", { ...db.get("rule_versions", "proposal"), id, approvalReview: {}, createdAt: old });
  assert.deepEqual(await repository.listPending("workspace", 2), ["proposal-a", "proposal-b"]);
  assert.deepEqual(await repository.listPending("workspace", 2), ["proposal-c"]);
  for (const id of ["proposal-a", "proposal-b", "proposal-c"]) db.get("rule_versions", id).approvalReview = { state: "human_required" };
  assert.deepEqual(await repository.listPending("workspace", 2), []);
});
test("projectless organization proposals retain eligibility while foreign or deleted rules cannot claim", async () => {
  const first = setup(), rule = first.db.get("rules", "rule"); delete rule.projectId; rule.scopeType = "organization"; rule.scopeId = "workspace";
  assert.deepEqual(await first.repository.listPending("workspace", 20), ["proposal"]); assert.equal(await first.repository.claim(pointer, "evaluation", config()), true);
  const foreign = setup(); foreign.db.get("rules", "rule").ownerWorkspaceId = "other"; assert.equal(await foreign.repository.claim(pointer, "evaluation", config()), false);
  const deleted = setup(); deleted.db.get("rules", "rule").deletedAt = new Date().toISOString(); assert.equal(await deleted.repository.claim(pointer, "evaluation", config()), false);
  const raced = setup(); assert.equal(await raced.repository.claim(pointer, "evaluation", config()), true); const loaded = await raced.repository.load(pointer); raced.db.get("rules", "rule").deletedAt = new Date().toISOString();
  assert.equal(await raced.repository.complete(pointer, "evaluation", contextDigest(loaded), decideApproval(loaded, config(), signals()), config()), "skipped");
});
test("manual mode performs no automatic work and shadow never changes approved pointer", async () => {
  const { db, repository } = setup(); let calls = 0;
  assert.equal((await new AutomaticApprovalService(repository, { evaluate: async () => { calls++; return signals(); } }, { ...config(), mode: "manual" }).scan()).reviewed, 0);
  assert.equal(calls, 0);
  assert.equal((await new AutomaticApprovalService(repository, { evaluate: async () => signals() }, { ...config(), mode: "shadow" }).scan()).humanRequired, 1);
  assert.equal(db.get("rules", "rule").currentVersionId, "old"); assert.equal(db.get("rule_versions", "proposal").approvalReview.wouldAutoApprove, true);
});
test("OIDC internal route rejects unauthorized requests and ignores forged policy input", async () => {
  let called = 0; const handler = createApprovalScanHandler({ scan: async () => { called++; return { policyVersion: "test", mode: "auto", reviewed: 0, autoApproved: 0, humanRequired: 0, skipped: 0, failed: 0, compilationDispatches: 0 }; } }, { verify: (token, audience) => token === "trusted" && audience === "aud" }, "aud");
  assert.equal((await handler(new Request("https://local/", { method: "GET" }))).status, 405);
  assert.equal((await handler(new Request("https://local/", { method: "POST" }))).status, 401);
  assert.equal((await handler(new Request("https://local/", { method: "POST", headers: { authorization: "Bearer attacker" } }))).status, 403);
  assert.equal(called, 0);
  assert.equal((await handler(new Request("https://local/", { method: "POST", headers: { authorization: "Bearer trusted" }, body: JSON.stringify({ workspaceId: "other", minJudgeScore: 0, autoApprove: true }) }))).status, 200); assert.equal(called, 1);
});
