import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticApprovalService } from "../src/shared/automatic-approval.ts";
import { FirestoreApprovalRepository } from "../src/shared/firestore-approval-repository.ts";
import { ApprovalEvaluationError, type ApprovalEvaluator } from "../src/shared/google-approval-review.ts";
import { safeEvaluationFailureCode, type ApprovalScanLog } from "../src/shared/approval-observability.ts";
import { database } from "./approval-memory-firestore.ts";
import { config, signals } from "./approval-fixture.ts";

function setup(evaluator: ApprovalEvaluator = { evaluate: async () => signals() }) {
  const db = database();
  const repository = new FirestoreApprovalRepository(db.asFirestore(), db.asStore());
  const logs: ApprovalScanLog[] = [];
  const logger = (entry: ApprovalScanLog) => { logs.push(structuredClone(entry)); };
  const service = new AutomaticApprovalService(repository, evaluator, config(), logger);
  return { db, repository, logs, logger, service };
}
function summary(logs: ApprovalScanLog[]): ApprovalScanLog {
  const entries = logs.filter((entry) => entry.event === "approval_scan_completed");
  assert.equal(entries.length, 1);
  return entries[0];
}

test("scan logs one correlated start/completion pair without changing the response contract", async () => {
  const { service, logs, db } = setup();
  const result = await service.scan(), entry = summary(logs);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, "approval_scan_started");
  assert.match(entry.scanId, /^[0-9a-f-]{36}$/);
  assert.equal(entry.scanId, logs[0].scanId);
  assert.equal(entry.severity, "INFO");
  assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs! >= 0);
  for (const [key, value] of Object.entries(result)) assert.equal(entry[key as keyof ApprovalScanLog], value);
  assert.equal(entry.evaluationFailures, 0);
  assert.equal(entry.evaluationApiFailures, 0);
  assert.equal(entry.compilationFailures, 0);
  assert.equal(result.autoApproved, 1);
  assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, false);
  assert.ok(!("evaluationFailures" in result), "diagnostics are log-only; retain the API contract");
  const text = JSON.stringify(logs);
  for (const sensitive of ["Use PascalCase", "export const Example", "workspace", "rulebranch-demo", "inputHash", "authorization"])
    assert.ok(!text.includes(sensitive), `must not log ${sensitive}`);
});

for (const code of ["GOOGLE_API_ERROR", "GOOGLE_API_UNAVAILABLE"]) {
  test(`${code} is distinguishable from scanner/storage failures`, async () => {
    const { service, logs, db } = setup({ evaluate: async () => { throw new ApprovalEvaluationError(code); } });
    const result = await service.scan(), entry = summary(logs);
    assert.equal(result.failed, 0);
    assert.equal(result.humanRequired, 1);
    assert.equal(result.autoApproved, 0);
    assert.equal(entry.evaluationFailures, 1);
    assert.equal(entry.evaluationApiFailures, 1);
    assert.deepEqual(entry.evaluationFailureReasons, { [code]: 1 });
    assert.equal(entry.severity, "WARNING");
    assert.equal(db.get("rules", "rule").currentVersionId, "old");
  });
}

test("a Model Armor block is an evaluation failure, not an API availability failure", async () => {
  const code = "MODEL_ARMOR_BLOCKED_OR_INCOMPLETE";
  const { service, logs } = setup({ evaluate: async () => { throw new ApprovalEvaluationError(code); } });
  assert.equal((await service.scan()).humanRequired, 1);
  const entry = summary(logs);
  assert.equal(entry.evaluationFailures, 1);
  assert.equal(entry.evaluationApiFailures, 0);
  assert.deepEqual(entry.evaluationFailureReasons, { [code]: 1 });
});

for (const wrapped of [false, true]) {
  test(`untrusted ${wrapped ? "wrapped code" : "exception message"} never enters logs or review metadata`, async () => {
    const privateText = "PRIVATE SOURCE bearer secret /customer/file.ts";
    const { service, logs, db } = setup({ evaluate: async () => {
      throw wrapped ? new ApprovalEvaluationError(privateText) : new Error(privateText);
    } });
    assert.equal((await service.scan()).humanRequired, 1);
    assert.deepEqual(summary(logs).evaluationFailureReasons, { EVALUATION_FAILED: 1 });
    assert.equal(summary(logs).evaluationApiFailures, 0);
    assert.ok(!JSON.stringify(logs).includes(privateText));
    assert.ok(!JSON.stringify([...db.docs.values()]).includes(privateText));
  });
}

test("protected inputs are not counted as provider failures and never call the evaluator", async () => {
  let calls = 0;
  const { db, service, logs } = setup({ evaluate: async () => { calls++; return signals(); } });
  db.get("rules", "rule").enforcement = "locked";
  assert.equal((await service.scan()).humanRequired, 1);
  assert.equal(calls, 0);
  assert.equal(summary(logs).evaluationFailures, 0);
});

test("individual dispatch failure is observable while durable intent and idempotent recovery remain intact", async () => {
  const { db, repository, service, logs, logger } = setup();
  db.failDispatch = true;
  const result = await service.scan(), entry = summary(logs);
  assert.equal(result.autoApproved, 1);
  assert.equal(result.failed, 0, "handled per-repository failure is not a scanner exception");
  assert.equal(entry.compilationFailures, 1);
  assert.equal(entry.severity, "WARNING");
  assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, true);
  assert.equal(db.dispatches.size, 0);
  db.failDispatch = false;
  logs.length = 0;
  const drain = new AutomaticApprovalService(repository, { evaluate: async () => { throw Error("must not reevaluate"); } }, { ...config(), mode: "shadow" }, logger);
  const drained = await drain.scan();
  assert.equal(drained.autoApproved, 0);
  assert.equal(drained.compilationDispatches, 1);
  assert.equal(summary(logs).compilationFailures, 0);
  assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, false);
  await drain.scan();
  assert.equal(db.dispatches.size, 1);
});

test("outbox query failure is counted separately from an evaluation API failure", async () => {
  const { repository, service, logs } = setup();
  repository.flushCompilations = async () => { throw Error("PRIVATE DATABASE ERROR"); };
  const result = await service.scan(), entry = summary(logs);
  assert.equal(result.failed, 2, "one flush before and one after the evaluation");
  assert.equal(entry.compilationFailures, 2);
  assert.equal(entry.evaluationApiFailures, 0);
  assert.ok(!JSON.stringify(logs).includes("PRIVATE DATABASE ERROR"));
});

test("candidate query failure is a scanner failure, not a dispatch/API failure", async () => {
  const { repository, service, logs } = setup();
  repository.listPending = async () => { throw Error("PRIVATE DATABASE ERROR"); };
  assert.equal((await service.scan()).failed, 1);
  const entry = summary(logs);
  assert.equal(entry.compilationFailures, 0);
  assert.equal(entry.evaluationApiFailures, 0);
  assert.equal(entry.severity, "WARNING");
  assert.ok(!JSON.stringify(logs).includes("PRIVATE DATABASE ERROR"));
});

for (const mode of ["manual", "shadow"] as const) {
  test(`${mode} still cannot automatically approve when telemetry is enabled`, async () => {
    const { repository, db, logger, logs } = setup();
    const service = new AutomaticApprovalService(repository, { evaluate: async () => signals() }, { ...config(), mode }, logger);
    const result = await service.scan();
    assert.equal(result.autoApproved, 0);
    assert.equal(result.reviewed, mode === "manual" ? 0 : 1);
    assert.equal(db.get("rules", "rule").currentVersionId, "old");
    assert.equal(db.dispatches.size, 0);
    assert.equal(summary(logs).mode, mode);
  });
}

test("a failing logger cannot stop approval or compilation dispatch", async () => {
  const { repository, db } = setup();
  const service = new AutomaticApprovalService(repository, { evaluate: async () => signals() }, config(), () => { throw Error("logging unavailable"); });
  assert.equal((await service.scan()).autoApproved, 1);
  assert.equal(db.dispatches.size, 1);
  assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, false);
});

test("a failing outbox observer cannot discard pending intent", async () => {
  const { repository, service, db } = setup();
  db.failDispatch = true;
  await service.scan();
  assert.equal(await repository.flushCompilations("workspace", () => { throw Error("observer failed"); }), 0);
  assert.equal(db.get("rule_versions", "proposal").approvalReview.compilePending, true);
});

test("the production logger writes parseable single-line JSON", async (t) => {
  const lines: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { lines.push(args); });
  const { repository } = setup();
  await new AutomaticApprovalService(repository, { evaluate: async () => signals() }, config()).scan();
  assert.equal(lines.length, 2);
  for (const args of lines) {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    const entry = JSON.parse(String(args[0]));
    assert.ok(["approval_scan_started", "approval_scan_completed"].includes(entry.event));
    assert.ok(!String(args[0]).includes("\n"));
  }
});

test("an unexpected top-level exception emits a safe failed event and still rejects", async () => {
  const { repository, logger, logs } = setup();
  const broken = config();
  broken.workspaceIds = new Proxy(broken.workspaceIds, { get(target, key, receiver) {
    if (key === Symbol.iterator) throw Error("PRIVATE TOP LEVEL ERROR");
    return Reflect.get(target, key, receiver);
  } });
  const service = new AutomaticApprovalService(repository, { evaluate: async () => signals() }, broken, logger);
  await assert.rejects(service.scan());
  assert.equal(logs.length, 2);
  assert.equal(logs[1].event, "approval_scan_failed");
  assert.equal(logs[1].severity, "ERROR");
  assert.equal(logs[1].errorCode, "APPROVAL_SCAN_FAILED");
  assert.ok(!JSON.stringify(logs).includes("PRIVATE TOP LEVEL ERROR"));
});

test("diagnostic keys use a bounded allowlist rather than arbitrary provider strings", () => {
  for (const code of [undefined, null, "", "__proto__", "constructor", "PRIVATE", "X".repeat(10000)])
    assert.equal(safeEvaluationFailureCode(code), "EVALUATION_FAILED");
  assert.equal(safeEvaluationFailureCode("INVALID_PROVIDER_RESPONSE"), "INVALID_PROVIDER_RESPONSE");
});
