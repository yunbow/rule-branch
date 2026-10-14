"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { isAbortError, LatestRequest } from "../../lib/latest-request.ts";
import { canApproveRuleVersion, hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { AiNotice } from "./AiNotice.tsx";
import { InjectionWarningBadge } from "./InjectionWarningBadge.tsx";
import { ApproveRejectDialog } from "./ApproveRejectDialog.tsx";
import { ApprovalReviewSummary } from "./ApprovalReviewSummary.tsx";
import { ActionDialog, Button, DialogActions, ErrorBanner, Markdown, Spinner, useToast } from "../ui/index.tsx";
import type { RuleListItem } from "./RuleRow.tsx";

type Version = { id: string; status: string; content?: string; rationale?: string; evidenceIds?: string[]; provenance?: { sourceType?: string }; possiblePromptInjection?: boolean; createdAt?: string; approvalReview?: unknown };
export function CandidateReviewPanel({ rule, workspaceId, workspaceKind, role, onDone }: { rule: RuleListItem; workspaceId: string; workspaceKind: WorkspaceKind; role: WorkspaceRole; onDone: () => void }) {
  const router = useRouter(), toast = useToast(), [versions, setVersions] = useState<Version[] | null>(null), [error, setError] = useState<string | null>(null), [approveOpen, setApproveOpen] = useState(false), [rejectOpen, setRejectOpen] = useState(false), [archiveOpen, setArchiveOpen] = useState(false), [action, setAction] = useState<"approve" | "reject" | "archive" | null>(null);
  const requests = useRef(new LatestRequest()), actionRef = useRef(false);
  const load = useCallback(async () => {
    const request = requests.current.begin();
    setError(null);
    try {
      const data = await apiFetch<{ ruleVersions: Version[] }>(`/api/rules/${rule.id}/versions?status=proposed`, { workspaceId, signal: request.signal });
      if (request.isCurrent()) setVersions(data.ruleVersions);
    } catch (e) {
      if (request.isCurrent() && !isAbortError(e)) setError(e instanceof ApiError ? e.code : "INTERNAL_ERROR");
    }
  }, [rule.id, workspaceId]);
  useEffect(() => {
    setVersions(null);
    void load();
    return () => requests.current.invalidate();
  }, [load]);
  const version = versions?.filter((item) => item.status === "proposed").sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
  const finish = () => { setApproveOpen(false); setRejectOpen(false); setArchiveOpen(false); onDone(); router.refresh(); };
  const run = async (kind: "approve" | "reject" | "archive", body: Record<string, unknown>) => { if (actionRef.current || (!version && kind !== "archive")) return; actionRef.current = true; setAction(kind); try { const path = kind === "approve" ? `/api/rule-versions/${version!.id}/approve` : kind === "reject" ? `/api/rule-versions/${version!.id}/reject` : `/api/rules/${rule.id}/status`; await apiFetch(path, { method: "POST", workspaceId, body }); finish(); } catch (e) { toast.add(getErrorMessage(e instanceof ApiError ? e.code : "INTERNAL_ERROR")); } finally { actionRef.current = false; setAction(null); } };
  const canWrite = hasWorkspacePermission(workspaceKind, role, "member"); const canApprove = canApproveRuleVersion({ workspaceKind, enforcement: rule.enforcement as "locked" | "default" | "advisory" | "personal", scopeType: rule.scopeType as "organization" | "project" | "user" | "team" }, role);
  return <><section className="card"><h2>候補レビュー</h2>{versions === null && <Spinner/>}{error && <><ErrorBanner code={error}/><Button type="button" onClick={load}>再試行</Button></>}{versions !== null && !version && <p>提案中の版はありません。</p>}{version && <><ApprovalReviewSummary version={version} workspaceId={workspaceId}/>{version.provenance?.sourceType === "ai" && <AiNotice/>}<Markdown>{version.content ?? ""}</Markdown><h3>根拠</h3><p>{version.rationale ?? "—"}</p><p>根拠 {version.evidenceIds?.length ?? 0}件</p>{(rule.possiblePromptInjection || version.possiblePromptInjection) && <p><InjectionWarningBadge/> (この Project の抽出ジョブ)</p>}<div>{canApprove && <Button type="button" onClick={() => setApproveOpen(true)}>承認</Button>}{canWrite && <Button type="button" variant="danger" onClick={() => setArchiveOpen(true)}>却下(アーカイブ)</Button>}{canWrite && <Button type="button" variant="secondary" onClick={() => setRejectOpen(true)}>この版のみ却下</Button>}</div></>}</section><ApproveRejectDialog mode="approve" open={approveOpen} loading={action === "approve"} onClose={() => setApproveOpen(false)} onSubmit={(comment) => void run("approve", { comment })}/><ApproveRejectDialog mode="reject" open={rejectOpen} loading={action === "reject"} onClose={() => setRejectOpen(false)} onSubmit={(reason) => void run("reject", { reason })}/><ActionDialog
  open={archiveOpen}
  onClose={() => setArchiveOpen(false)}
  title="ルールをアーカイブしますか？"
  actions={<DialogActions
    onCancel={() => setArchiveOpen(false)}
    onConfirm={() => void run("archive", { status: "archived" })}
    confirmLabel="却下(アーカイブ)"
    confirmVariant="danger"
    loading={action === "archive"}
  />}
>
    <p>このルールと提案中の版をアーカイブします。</p>
</ActionDialog></>;
}
