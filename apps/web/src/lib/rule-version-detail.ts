export type VersionReviewInput = {
  status?: unknown;
  approvedBy?: unknown;
  approvedAt?: unknown;
  rejectionReason?: unknown;
  approvalReview?: unknown;
};

export type VersionReviewPresentation = {
  kind: "approved" | "rejected" | "proposed" | "withdrawn" | "superseded" | "other";
  message: string;
  method: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
};

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function ruleVersionDetailUrl({
  workspaceId,
  projectId,
  ruleId,
  versionId,
}: {
  workspaceId: string;
  projectId?: string;
  ruleId: string;
  versionId: string;
}): string {
  return "/w/" + encodeURIComponent(workspaceId)
    + (projectId ? "/projects/" + encodeURIComponent(projectId) : "")
    + "/rules/" + encodeURIComponent(ruleId)
    + "/versions/" + encodeURIComponent(versionId);
}

export function getVersionReviewPresentation(version: VersionReviewInput): VersionReviewPresentation {
  const status = String(version.status ?? "");
  const review = version.approvalReview && typeof version.approvalReview === "object"
    ? version.approvalReview as Record<string, unknown>
    : null;
  const automatic = review?.state === "auto_approved";
  const approvedBy = nonEmptyText(version.approvedBy);
  const approvedAt = nonEmptyText(version.approvedAt);
  const rejectionReason = nonEmptyText(version.rejectionReason);

  if (status === "approved" || (status === "superseded" && (automatic || approvedBy || approvedAt))) {
    return {
      kind: status === "superseded" ? "superseded" : "approved",
      message: status === "superseded" ? "このバージョンは旧版です。" : automatic ? "委任ポリシーにより自動承認されました。" : "このバージョンは承認済みです。",
      method: automatic ? "自動承認（委任ポリシー）" : approvedBy ? "人間による承認" : "承認済み",
      approvedBy: automatic ? null : approvedBy,
      approvedAt,
      rejectionReason: null,
    };
  }
  const messages: Record<string, { kind: VersionReviewPresentation["kind"]; message: string }> = {
    proposed: { kind: "proposed", message: "このバージョンはまだ承認されていません。" },
    rejected: { kind: "rejected", message: "このバージョンは却下されました。" },
    withdrawn: { kind: "withdrawn", message: "このバージョンは取り下げられています。" },
    superseded: { kind: "superseded", message: "このバージョンは旧版です。" },
  };
  const match = messages[status] ?? { kind: "other" as const, message: "レビューの記録を確認してください。" };
  return { ...match, method: null, approvedBy: null, approvedAt: null, rejectionReason: status === "rejected" ? rejectionReason : null };
}

/** Proposal replacement is explicit; otherwise use the approved baseline at creation. */
export function getVersionSource(version: Record<string, unknown>, versions: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (typeof version.supersedes === "string") return versions.find((item) => item.id === version.supersedes);
  return versions.filter((item) => Number(item.version) < Number(version.version)
    && typeof item.approvedAt === "string"
    && (typeof version.createdAt !== "string" || Date.parse(item.approvedAt) <= Date.parse(version.createdAt)))
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
}
