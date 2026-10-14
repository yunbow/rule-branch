import test from "node:test";
import assert from "node:assert/strict";
import { toReviewScore } from "../src/lib/review-score.ts";

test("missing AI scores are not rendered as zero", () => {
  for (const missing of [null, undefined, "", " ", "n/a", false, NaN, Infinity, {}]) {
    assert.equal(toReviewScore(missing), null);
  }
});

test("valid evaluator numbers are normalized to a 0–1 scale", () => {
  assert.equal(toReviewScore(0), 0);
  assert.equal(toReviewScore("0.45"), .45);
  assert.equal(toReviewScore(2), 1);
  assert.equal(toReviewScore(-1), 0);
});
