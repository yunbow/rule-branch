import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_VERSION_CONTENT_BYTES,
  MAX_VERSION_RATIONALE_BYTES,
  MAX_VERSION_EVIDENCE,
  CHANGE_TYPE_DESCRIPTION,
  parseCompatibilityJson,
  parseEvidenceIdInput,
  uniqueEvidenceIds,
  validateVersionCreate,
  createVersionErrorMessage,
} from "../src/lib/version-create.ts";

const base = {
  content: "# セキュリティルール\n認証情報をファイルへ保存しない",
  rationale: "元の提案で曖昧だった適用範囲を明確化した。",
  evidenceIds: ["evidence-1", "evidence-2"],
  compatibilityJson: '{"tools":{"git":"supported"}}',
  sourceStatus: "proposed",
};

test("revision validation accepts a proposed source and a JSON object", () => {
  const result = validateVersionCreate(base);
  assert.equal(result.valid, true);
  assert.equal(result.contentError, null);
  assert.equal(result.rationaleError, null);
  assert.deepEqual(result.compatibilityValue, { tools: { git: "supported" } });
});

test("content and new rationale cannot contain only whitespace", () => {
  const contentBlank = validateVersionCreate({ ...base, content: " \n\t" });
  assert.match(contentBlank.contentError ?? "", /本文/);
  const rationaleBlank = validateVersionCreate({ ...base, rationale: " \n" });
  assert.match(rationaleBlank.rationaleError ?? "", /変更理由/);
  assert.equal(contentBlank.valid, false);
  assert.equal(rationaleBlank.valid, false);
});

test("limits apply to UTF-8 bytes rather than JavaScript string lengths", () => {
  const largeContent = validateVersionCreate({ ...base, content: "あ".repeat(Math.ceil(MAX_VERSION_CONTENT_BYTES / 3)) });
  const largeRationale = validateVersionCreate({ ...base, rationale: "界".repeat(Math.ceil(MAX_VERSION_RATIONALE_BYTES / 3)) });
  assert.match(largeContent.contentError ?? "", /32,768/);
  assert.match(largeRationale.rationaleError ?? "", /8,192/);
});

test("compatibility JSON must be a non-null object", () => {
  for (const json of ["null", "[]", '"hello"', "2", "true", "{broken"]) {
    const parsed = parseCompatibilityJson(json);
    assert.notEqual(parsed.error, null, json);
    const result = validateVersionCreate({ ...base, compatibilityJson: json });
    assert.equal(result.valid, false);
    assert.equal(result.compatibilityValue, null);
  }
  assert.deepEqual(parseCompatibilityJson("{}").value, {});
});

test("evidence IDs are trimmed, deduplicated, and limited to twenty", () => {
  assert.deepEqual(parseEvidenceIdInput(" a, b\n a,\n c "), ["a", "b", "c"]);
  assert.deepEqual(uniqueEvidenceIds([" a ", "a", "", "b"]), ["a", "b"]);
  assert.equal(validateVersionCreate({ ...base, evidenceIds: Array.from({ length: MAX_VERSION_EVIDENCE }, (_, i) => "e" + i) }).valid, true);
  assert.match(validateVersionCreate({ ...base, evidenceIds: Array.from({ length: MAX_VERSION_EVIDENCE + 1 }, (_, i) => "e" + i) }).evidenceError ?? "", /20件/);
});

test("source status must still be proposed to create a correction", () => {
  for (const status of ["approved", "rejected", "withdrawn", "superseded"]) {
    const result = validateVersionCreate({ ...base, sourceStatus: status });
    assert.equal(result.valid, false, status);
    assert.match(result.sourceError ?? "", /提案中/);
  }
  assert.equal(validateVersionCreate({ ...base, sourceStatus: undefined }).valid, true);
});

test("concurrent source changes return a specific non-destructive message", () => {
  assert.match(createVersionErrorMessage("SUPERSEDES_INVALID") ?? "", /入力内容は保持/);
  assert.match(createVersionErrorMessage("RULE_STATUS_INVALID") ?? "", /状態/);
  assert.equal(createVersionErrorMessage("UNRELATED_ERROR"), null);
  assert.ok(CHANGE_TYPE_DESCRIPTION.clarify.includes("明確"));
});
