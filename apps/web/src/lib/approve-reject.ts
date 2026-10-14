export type ApproveRejectMode = "approve" | "reject";
export function isApproveRejectValid(mode: ApproveRejectMode, value: string): boolean { return mode === "approve" || value.trim().length > 0; }
