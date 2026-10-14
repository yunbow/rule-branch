import test from "node:test";
import assert from "node:assert/strict";
import { getVersionReviewPresentation, ruleVersionDetailUrl } from "../src/lib/rule-version-detail.ts";

test("links to source versions retain the /versions/ segment", () => {
  assert.equal(ruleVersionDetailUrl({
    workspaceId: "workspace", projectId: "project", ruleId: "rule", versionId: "source-version",
  }), "/w/workspace/projects/project/rules/rule/versions/source-version");
  assert.equal(ruleVersionDetailUrl({
    workspaceId: "w space", projectId: "p", ruleId: "r", versionId: "v#1",
  }), "/w/w%20space/projects/p/rules/r/versions/v%231");
});

test("a proposal does not invent an approver or rejection reason", () => {
  assert.deepEqual(getVersionReviewPresentation({ status: "proposed" }), {
    kind: "proposed", message: "このバージョンはまだ承認されていません。",
    method: null, approvedBy: null, approvedAt: null, rejectionReason: null,
  });
});

test("automatic approval is not mistaken for a human review", () => {
  const result = getVersionReviewPresentation({
    status: "approved", approvedBy: "service-account", approvedAt: "2026-10-10T00:00:00Z",
    approvalReview: { state: "auto_approved" },
  });
  assert.equal(result.kind, "approved");
  assert.equal(result.method, "自動承認（委任ポリシー）");
  assert.equal(result.approvedBy, null);
  assert.equal(result.approvedAt, "2026-10-10T00:00:00Z");
});

test("human approval and rejection are shown with their respective metadata", () => {
  const human = getVersionReviewPresentation({ status: "approved", approvedBy: "reviewer" });
  assert.equal(human.method, "人間による承認");
  assert.equal(human.approvedBy, "reviewer");
  const rejected = getVersionReviewPresentation({ status: "rejected", rejectionReason: "Evidence不足" });
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.rejectionReason, "Evidence不足");
  assert.equal(rejected.approvedBy, null);
});

test("superseding an approved version preserves its approval history", () => {
  const approvedAt = "2026-10-10T00:00:00Z";
  const human = getVersionReviewPresentation({ status: "superseded", approvedBy: "reviewer", approvedAt });
  assert.equal(human.kind, "superseded");
  assert.equal(human.message, "このバージョンは旧版です。");
  assert.equal(human.method, "人間による承認");
  assert.equal(human.approvedBy, "reviewer");
  assert.equal(human.approvedAt, approvedAt);

  const automatic = getVersionReviewPresentation({
    status: "superseded", approvedBy: null, approvedAt, approvalReview: { state: "auto_approved" },
  });
  assert.equal(automatic.kind, "superseded");
  assert.equal(automatic.method, "自動承認（委任ポリシー）");
  assert.equal(automatic.approvedBy, null);
  assert.equal(automatic.approvedAt, approvedAt);
  assert.equal(getVersionReviewPresentation({ status: "superseded" }).method, null);
});

test("organization source version links omit the project segment and escape IDs", () => {
  assert.equal(ruleVersionDetailUrl({ workspaceId: "w space", ruleId: "r", versionId: "v#1" }),
    "/w/w%20space/rules/r/versions/v%231");
});

test("revision source is the approved version at proposal creation, including after approval", async () => {
  const { getVersionSource } = await import("../src/lib/rule-version-detail.ts");
  const v1 = { id: "v1", version: 1, approvedAt: "2026-10-01T00:00:00Z", status: "superseded" };
  const v2 = { id: "v2", version: 2, createdAt: "2026-10-02T00:00:00Z", approvedAt: "2026-10-03T00:00:00Z" };
  assert.equal(getVersionSource(v2, [v1, v2])?.id, "v1");
  assert.equal(getVersionSource(v1, [v1, v2]), undefined);
  const rejected = { id: "rejected", version: 3, status: "rejected" };
  const later = { id: "later", version: 4, approvedAt: "2026-10-05T00:00:00Z" };
  assert.equal(getVersionSource({ id: "v5", version: 5, createdAt: "2026-10-04T00:00:00Z" }, [v1, v2, rejected, later])?.id, "v2");
  assert.equal(getVersionSource({ ...v2, supersedes: "rejected" }, [v1, v2, rejected])?.id, "rejected");
});
