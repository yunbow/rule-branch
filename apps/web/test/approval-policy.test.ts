import test from "node:test";
import assert from "node:assert/strict";
import { approvalRiskReasons, contextDigest, decideApproval, loadApprovalConfig, isUnitScore } from "../src/shared/approval-policy.ts";
import { config, context, signals } from "./approval-fixture.ts";

test("eligible maintenance change requires every independent gate", () => {
  assert.deepEqual(approvalRiskReasons(context(), config()), []);
  assert.equal(decideApproval(context(), config(), signals()).state, "auto_approved");
  for (const patch of [{ judgeScore: 0.94 }, { groundednessConfidence: 0.94 }, { groundednessScore: 0 }, { armorPassed: false }, { risk: "HIGH" }, { recommendation: "ESCALATE" }, { conflictsWithRules: true }, { preservesIntent: false }, { weakensProtection: true }]) {
    assert.equal(decideApproval(context(), config(), { ...signals(), ...patch } as ReturnType<typeof signals>).state, "human_required");
  }
});
for (const [name, patch] of Object.entries({ L1: { layer: "L1" }, L2: { layer: "L2" }, locked: { enforcement: "locked" }, security: { type: "security" }, architecture: { type: "architecture" }, organization: { scopeType: "organization" }, executable: { evaluationMode: "hybrid" } })) {
  test(`high confidence does not override ${name}`, () => { const c = context(); Object.assign(c.rule, patch); assert.equal(decideApproval(c, config(), signals()).state, "human_required"); });
}
test("initial adoption, missing consent, evidence changes and unknown jobs escalate", () => {
  for (const mutate of [
    (c: ReturnType<typeof context>) => { c.currentVersion = null; },
    (c: ReturnType<typeof context>) => { c.workspace.settings = {}; },
    (c: ReturnType<typeof context>) => { c.evidence[0].excerpt = "tampered"; },
    (c: ReturnType<typeof context>) => { c.evidence[0].ref = { commitSha: null }; },
    (c: ReturnType<typeof context>) => { c.findings[0].status = "dismissed"; },
    (c: ReturnType<typeof context>) => { c.warnings.push("SOURCE_JOB_INCOMPLETE"); },
    (c: ReturnType<typeof context>) => { c.evidence = []; },
  ]) { const c = context(); mutate(c); assert.equal(decideApproval(c, config(), signals()).state, "human_required"); }
});
test("shadow mode records the hypothetical result but never approves", () => {
  const outcome = decideApproval(context(), { ...config(), mode: "shadow" }, signals());
  assert.equal(outcome.state, "human_required"); assert.equal(outcome.wouldAutoApprove, true); assert.ok(outcome.reasonCodes.includes("SHADOW_MODE"));
  assert.equal(loadApprovalConfig({}).mode, "manual");
});
test("scores must be finite numeric values and configuration fails closed", () => {
  for (const value of [NaN, Infinity, -1, 1.01, "0.99", true, undefined]) assert.equal(isUnitScore(value), false);
  assert.throws(() => loadApprovalConfig({ RULEBRANCH_APPROVAL_MIN_JUDGE_SCORE: "0.1" }));
  assert.throws(() => loadApprovalConfig({ RULEBRANCH_APPROVAL_MODE: "whatever" }));
  assert.throws(() => loadApprovalConfig({ RULEBRANCH_APPROVAL_WORKSPACE_IDS: "../other" }));
});
test("fingerprint excludes lease metadata, but includes rule and evidence changes", () => {
  const c = context(), original = contextDigest(c);
  c.proposal.approvalReview = { state: "evaluating" }; c.proposal.updatedAt = new Date().toISOString();
  assert.equal(contextDigest(c), original);
  c.rule.enforcement = "locked"; assert.notEqual(contextDigest(c), original);
});

test("tightening, relaxing, deprecating and unknown change types require human judgment", () => {
  for (const changeType of ["initial", "tighten", "relax", "deprecate", "unknown"]) { const c = context(); c.proposal.changeType = changeType; assert.equal(decideApproval(c, config(), signals()).state, "human_required"); }
});
