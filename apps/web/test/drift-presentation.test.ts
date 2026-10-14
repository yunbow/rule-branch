import test from "node:test";
import assert from "node:assert/strict";
import { countDriftStatus, formatDriftDate, presentDriftFindings } from "../src/lib/drift-presentation.ts";

test("drift dates render identically across server and browser time zones", () => {
  const previousTimeZone = process.env.TZ;
  const value = "2026-10-12T15:15:08.000Z";
  try {
    process.env.TZ = "UTC";
    assert.equal(new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(value)), "2026/10/12");
    assert.equal(formatDriftDate(value), "2026/10/13");

    process.env.TZ = "Asia/Tokyo";
    assert.equal(new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(value)), "2026/10/13");
    assert.equal(formatDriftDate(value), "2026/10/13");
    assert.equal(formatDriftDate("not-a-date"), "—");
    assert.equal(formatDriftDate(), "—");
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

const findings = [
  {
    id: "low", ruleId: "r1", status: "open", driftType: "dependency_drift",
    severity: "low", confidence: 0.95, createdAt: "2026-10-10T10:00:00Z",
    summary: "Change in react", detail: "Version change", repositoryId: "a",
  },
  {
    id: "high-accepted", ruleId: "r2", status: "accepted", driftType: "dependency_drift",
    severity: "high", confidence: 0.95, createdAt: "2026-10-09T10:00:00Z",
    summary: "Kotlin upgrade", repositoryId: "b",
  },
  {
    id: "high-open", ruleId: "r1", status: "open", driftType: "artifact_mismatch",
    severity: "high", confidence: 0.65, createdAt: "2026-10-08T10:00:00Z",
    summary: "Generated AGENTS.md changed", path: "AGENTS.md", repositoryId: "a",
  },
  {
    id: "medium", ruleId: "r1", status: "open", driftType: "dependency_drift",
    severity: "medium", confidence: 0.6, createdAt: "2026-10-11T10:00:00Z",
    summary: "Dependency mismatch", repositoryId: "a",
  },
];

test("default view sorts by severity, then unresolved status, then recency", () => {
  const ids = presentDriftFindings(findings, {}, {}).map((item) => item.id);
  assert.deepEqual(ids, ["high-open", "high-accepted", "medium", "low"]);
  assert.deepEqual(findings.map((item) => item.id), ["low", "high-accepted", "high-open", "medium"]);
});

test("recent and confidence sorting are independent from severity ranking", () => {
  assert.deepEqual(
    presentDriftFindings(findings, { sort: "recent" }).map((item) => item.id),
    ["medium", "low", "high-accepted", "high-open"],
  );
  assert.deepEqual(
    presentDriftFindings(findings, { sort: "confidence" }).map((item) => item.id),
    ["high-accepted", "low", "high-open", "medium"],
  );
});

test("findings can be searched by rule title, detail, or exact path substring", () => {
  const titles = { r1: "安全な開発", r2: "Kotlin rules" };
  assert.deepEqual(
    presentDriftFindings(findings, { search: "安全な" }, titles).map((item) => item.id),
    ["high-open", "medium", "low"],
  );
  assert.deepEqual(
    presentDriftFindings(findings, { search: "AGENTS.md" }, titles).map((item) => item.id),
    ["high-open"],
  );
  assert.deepEqual(
    presentDriftFindings(findings, { search: "version change" }, titles).map((item) => item.id),
    ["low"],
  );
});

test("repository and severity filters can be combined", () => {
  assert.deepEqual(
    presentDriftFindings(findings, { severity: "high", repositoryId: "a" }).map((item) => item.id),
    ["high-open"],
  );
  assert.deepEqual(
    presentDriftFindings([...findings, { id: "unknown", severity: "high", status: "open" }],
      { repositoryId: "a" }).map((item) => item.id),
    ["high-open", "medium", "low"],
  );
});

test("unknown dates and values are sorted deterministically", () => {
  const items = [{ id: "z", severity: "unknown", createdAt: "invalid", confidence: "not-number" },
    { id: "a", severity: "unknown", createdAt: null, confidence: null }];
  assert.deepEqual(presentDriftFindings(items, {}).map((item) => item.id), ["a", "z"]);
});

test("status counters distinguish waiting and accepted without claiming resolution", () => {
  assert.deepEqual(countDriftStatus(findings), { open: 3, accepted: 1 });
});
