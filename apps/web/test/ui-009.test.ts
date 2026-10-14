import assert from "node:assert/strict";
import test from "node:test";
import { driftTypeLabel, isBelowStaleThreshold, severityLabel, driftActionPermissions } from "../src/lib/drift-list.ts";

test("UI-009 drift type and severity labels use labels.ts", () => { assert.equal(driftTypeLabel("artifact_mismatch"), "生成物の改変"); assert.equal(driftTypeLabel("dependency_drift"), "依存関係の変更"); assert.equal(severityLabel("high"), "高"); assert.equal(severityLabel("low"), "低"); });
test("UI-009 confidence threshold needs medium severity and 0.6 confidence", () => { assert.equal(isBelowStaleThreshold("low", .9), true); assert.equal(isBelowStaleThreshold("medium", .59), true); assert.equal(isBelowStaleThreshold("medium", .6), false); assert.equal(isBelowStaleThreshold("high", .85), false); });
test("UI-009 action visibility follows triage and write permissions", () => { assert.deepEqual(driftActionPermissions("organization", "viewer"), { triage: false, manualTrigger: false }); assert.deepEqual(driftActionPermissions("organization", "member"), { triage: false, manualTrigger: true }); assert.deepEqual(driftActionPermissions("organization", "maintainer"), { triage: true, manualTrigger: true }); assert.deepEqual(driftActionPermissions("personal", "owner"), { triage: true, manualTrigger: true }); });
