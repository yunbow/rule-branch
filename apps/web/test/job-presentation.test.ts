import assert from "node:assert/strict";
import test from "node:test";
import { elapsedJobSeconds, formatJobDate } from "../src/lib/job-presentation.ts";

test("job timestamps render identically across server and browser time zones", () => {
  const original = process.env.TZ;
  const value = "2026-10-12T14:53:04Z";
  try {
    process.env.TZ = "UTC";
    const serverShort = formatJobDate(value, "short");
    const serverMedium = formatJobDate(value, "medium");
    process.env.TZ = "Asia/Tokyo";
    assert.equal(formatJobDate(value, "short"), serverShort);
    assert.equal(formatJobDate(value, "medium"), serverMedium);
    assert.match(serverShort, /2026\/10\/12.*23:53/);
    assert.match(serverMedium, /2026\/10\/12.*23:53:04/);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("job timestamps handle a UTC-to-JST date boundary and invalid input", () => {
  assert.match(formatJobDate("2026-10-12T18:00:00Z", "short"), /2026\/10\/13.*3:00/);
  assert.equal(formatJobDate("not-a-date", "short"), "—");
  assert.equal(formatJobDate(undefined, "medium"), "—");
});

test("elapsed time is deterministic until a mounted clock is supplied", () => {
  assert.equal(elapsedJobSeconds("2026-10-12T18:00:00Z", null), null);
  assert.equal(elapsedJobSeconds("2026-10-12T18:00:00Z", Date.parse("2026-10-12T18:00:42Z")), 42);
  assert.equal(elapsedJobSeconds("invalid", Date.now()), null);
});
