import test from "node:test";
import assert from "node:assert/strict";
import { GoogleApprovalEvaluator, ApprovalEvaluationError } from "../src/shared/google-approval-review.ts";
import { config, context, signals } from "./approval-fixture.ts";
const safeArmor = () => ({ sanitizationResult: { invocationResult: "SUCCESS", filterMatchState: "NO_MATCH_FOUND", filterResults: { pi_and_jailbreak: { piAndJailbreakFilterResult: { executionState: "EXECUTION_SUCCESS", matchState: "NO_MATCH_FOUND" } } } } });
function provider(override?: (url: string, body: Record<string, any>, result: any) => any) {
  const calls: { url: string; body: Record<string, any> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body)); calls.push({ url, body });
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal); assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    let result: any;
    if (url.includes("modelarmor")) result = safeArmor();
    else if (url.includes("generateContent")) result = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(signals()) }] } }] };
    else if (body.pointwiseMetricInput) result = { pointwiseMetricResult: { score: 0.98, explanation: "supported" } };
    else result = { groundednessResult: { score: 1, confidence: 0.98, explanation: "grounded" } };
    return Response.json(override ? override(url, body, result) : result);
  };
  return { calls, evaluator: new GoogleApprovalEvaluator(config(), fetcher, async () => "test-token") };
}
test("Google REST schemas and input/output armor are wired together", async () => {
  const p = provider(); assert.deepEqual(await p.evaluator.evaluate(context()), signals());
  assert.equal(p.calls.length, 5); assert.ok(p.calls[0].url.endsWith(":sanitizeUserPrompt")); assert.ok(p.calls.at(-1)?.url.endsWith(":sanitizeModelResponse"));
  const pointwise = p.calls.find((c) => c.body.pointwiseMetricInput)!.body.pointwiseMetricInput;
  assert.equal(typeof JSON.parse(pointwise.instance.jsonInstance).review_data, "string"); assert.ok(pointwise.metricSpec.metricPromptTemplate.includes("{review_data}"));
  assert.ok(p.calls.find((c) => c.body.generationConfig)!.body.generationConfig.responseSchema.required.includes("preservesIntent"));
});
for (const [name, override] of Object.entries({
  "partial armor": (url: string, _body: any, value: any) => url.includes("modelarmor") ? { sanitizationResult: { ...value.sanitizationResult, invocationResult: "PARTIAL" } } : value,
  "missing injection filter": (url: string, _body: any, value: any) => url.includes("modelarmor") ? { sanitizationResult: { ...value.sanitizationResult, filterResults: {} } } : value,
  "matched injection": (url: string, _body: any, value: any) => url.includes("modelarmor") ? { sanitizationResult: { ...value.sanitizationResult, filterMatchState: "MATCH_FOUND" } } : value,
  "missing grounded confidence": (_url: string, body: any, value: any) => body.groundednessInput ? { groundednessResult: { score: 1, explanation: "x" } } : value,
  "string score": (_url: string, body: any, value: any) => body.pointwiseMetricInput ? { pointwiseMetricResult: { score: "0.98", explanation: "x" } } : value,
  "truncated Gemini": (url: string, _body: any, value: any) => url.includes("generateContent") ? { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }] } : value,
  "boolean grounding score": (_url: string, body: any, value: any) => body.groundednessInput ? { groundednessResult: { score: true, confidence: 1, explanation: "x" } } : value,
})) test(`${name} cannot produce an approval signal`, async () => { await assert.rejects(provider(override).evaluator.evaluate(context()), ApprovalEvaluationError); });
test("HTTP failure and timeout are errors, not high scores", async () => {
  await assert.rejects(new GoogleApprovalEvaluator(config(), async () => new Response("secret-code", { status: 429 }), async () => "token").evaluate(context()), { message: "GOOGLE_API_ERROR" });
  await assert.rejects(new GoogleApprovalEvaluator(config(), async () => { throw new Error("secret-code"); }, async () => "token").evaluate(context()), { message: "GOOGLE_API_UNAVAILABLE" });
});
test("oversized context is never silently truncated", async () => { const c = context(); c.proposal.content = "x".repeat(20001); const p = provider(); await assert.rejects(p.evaluator.evaluate(c), { message: "REVIEW_INPUT_TOO_LARGE" }); assert.equal(p.calls.length, 0); });
