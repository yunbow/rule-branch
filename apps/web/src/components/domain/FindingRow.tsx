"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { driftTypeLabel } from "../../lib/drift-list.ts";
import { formatDriftDate } from "../../lib/drift-presentation.ts";
import { getErrorMessage, SYSTEM_DETECTED_NOTICE } from "../../lib/messages.ts";
import { canTriage, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { AiNotice, ProvenanceBadge } from "./index.tsx";
import { EvidenceList } from "./EvidenceList.tsx";
import { ProposalGenerateButton } from "./ProposalGenerateButton.tsx";
import { ConfidenceBar } from "./ConfidenceBar.tsx";
import { SeverityBadge } from "./SeverityBadge.tsx";
import { ActionDialog, Button, DialogActions, StatusBadge, TextArea, useToast } from "../ui/index.tsx";

export type FindingView = Record<string, unknown> & {
  id: string;
  ruleId?: string | null;
  repositoryId?: string | null;
  status: string;
  driftType: string;
  severity: string;
  confidence: number;
  summary?: string;
  detail?: string;
  createdAt?: string;
  proposalVersionId?: string | null;
  evidenceIds?: string[];
  provenance?: { sourceType?: string };
  proposalVersionStatus?: string | null;
};

type Repository = { id: string; fullName: string };

export function FindingRow({
  finding, ruleTitle, workspaceId, projectId, workspaceKind, role, repositories,
  initialExpanded = false, showRuleLink = true,
}: {
  finding: FindingView;
  ruleTitle: string;
  workspaceId: string;
  projectId: string;
  workspaceKind: WorkspaceKind;
  role: WorkspaceRole;
  repositories: Repository[];
  initialExpanded?: boolean;
  showRuleLink?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(initialExpanded);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState(finding.status);
  useEffect(() => { setCurrentStatus(finding.status); }, [finding.status]);
  useEffect(() => { if (initialExpanded) setExpanded(true); }, [initialExpanded]);

  const triage = canTriage(workspaceKind, role);
  const sourceType = finding.provenance?.sourceType ?? "ai";
  const canUntriage = currentStatus === "accepted" && (
    !finding.proposalVersionId || ["rejected", "withdrawn"].includes(finding.proposalVersionStatus ?? "")
  );
  const repository = repositories.find((item) => item.id === finding.repositoryId);
  const ids = Array.isArray(finding.evidenceIds)
    ? finding.evidenceIds.filter((id): id is string => typeof id === "string")
    : [];
  const confidencePercent = Number.isFinite(finding.confidence)
    ? Math.round(Math.min(1, Math.max(0, finding.confidence)) * 100)
    : 0;

  const action = async (
    name: "accept" | "dismiss" | "reopen" | "untriage", dismissReason?: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/drift-findings/${encodeURIComponent(finding.id)}/${name}`, {
        method: "POST", workspaceId,
        body: dismissReason ? { dismissReason } : {},
      });
      const nextStatus = name === "accept" ? "accepted" : name === "dismiss" ? "dismissed" : "open";
      setCurrentStatus(nextStatus);
      toast.add(name === "accept" ? "対応対象に追加しました。次に改定提案を確認できます。" :
        name === "dismiss" ? "指摘を見送りました" :
        name === "reopen" ? "指摘を再オープンしました" : "対応中を解除しました");
      router.refresh();
      return true;
    } catch (cause) {
      setError(getErrorMessage(cause instanceof ApiError ? cause.code : "INTERNAL_ERROR"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const closeDismiss = () => {
    if (!busy) { setDismissOpen(false); setError(null); }
  };
  const submitDismiss = async () => {
    if (!reason.trim()) return;
    if (await action("dismiss", reason)) {
      setDismissOpen(false);
      setReason("");
    }
  };

  return <article id={`drift-${finding.id}`}
    className={"driftFindingCard" + (initialExpanded ? " driftFindingFocused" : "")}>
    <div className="driftFindingMain">
      <div className="driftFindingCopy">
        {showRuleLink && (finding.ruleId
          ? <Link className="driftFindingRuleLink"
              href={`/w/${workspaceId}/projects/${projectId}/rules/${finding.ruleId}`}>
              {ruleTitle}
            </Link>
          : <strong className="driftFindingRuleLink">{ruleTitle}</strong>)}
        <h3>{finding.summary ?? "概要はありません。"}</h3>
        <div className="driftFindingChips">
          <SeverityBadge severity={finding.severity}/>
          <StatusBadge kind="drift_findings.status" value={currentStatus}/>
          <span className="driftFindingType">{driftTypeLabel(finding.driftType)}</span>
        </div>
        <div className="driftFindingMetadata">
          <span>検出 {formatDriftDate(finding.createdAt)}</span>
          <span>確信度 {confidencePercent}%</span>
          {repository && <span>{repository.fullName}</span>}
          {ids.length > 0 && <span>根拠 {ids.length}件</span>}
        </div>
      </div>
      <button type="button" className="driftFindingExpand"
        aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
        onClick={() => setExpanded((value) => !value)}>
        {expanded ? "詳細を閉じる" : "詳細・根拠を見る"}
      </button>
    </div>

    {error && !dismissOpen && <p className="driftFindingError" role="alert">{error}</p>}

    {expanded && <div className="driftFindingExpanded" id={detailsId}>
      <dl className="driftFindingDetails">
        <div><dt>種類</dt><dd>{driftTypeLabel(finding.driftType)}</dd></div>
        <div><dt>確信度</dt><dd><ConfidenceBar confidence={finding.confidence} severity={finding.severity}/></dd></div>
        <div><dt>検出元</dt><dd><ProvenanceBadge sourceType={sourceType}/></dd></div>
        <div><dt>検出契機</dt><dd>{finding.driftType === "artifact_mismatch" ? "反映検証" : "依存関係変更 / 手動"}</dd></div>
      </dl>
      {sourceType === "ai" && <AiNotice/>}
      {sourceType === "system" && <div className="noticeBanner">{SYSTEM_DETECTED_NOTICE}</div>}
      <p className="driftFindingDetailText">{finding.detail ?? "詳細情報はありません。"}</p>
      <section className="driftFindingEvidence" aria-label="指摘の根拠">
        <h4>根拠 {ids.length}件</h4>
        <EvidenceList workspaceId={workspaceId} evidenceIds={ids} repositories={repositories}/>
      </section>
    </div>}

    <footer className="driftFindingActions">
      {triage && currentStatus === "open" && <>
        <Button type="button" loading={busy} disabled={busy}
          onClick={() => void action("accept")}>対応対象に追加</Button>
        <Button type="button" variant="secondary" disabled={busy}
          onClick={() => { setError(null); setDismissOpen(true); }}>見送る</Button>
      </>}
      {triage && ["dismissed", "expired"].includes(currentStatus) &&
        <Button type="button" loading={busy} disabled={busy}
          onClick={() => void action("reopen")}>再オープン</Button>}
      {triage && canUntriage &&
        <Button type="button" variant="secondary" loading={busy} disabled={busy}
          onClick={() => void action("untriage")}>対応中を解除</Button>}
      {currentStatus === "accepted" && triage && finding.ruleId
        ? <ProposalGenerateButton
            findingId={finding.id} ruleId={finding.ruleId}
            proposalVersionId={finding.proposalVersionId}
            workspaceId={workspaceId} projectId={projectId}/>
        : finding.proposalVersionId && finding.ruleId
          ? <Link className="button secondary"
              href={`/w/${workspaceId}/projects/${projectId}/rules/${finding.ruleId}/versions/${finding.proposalVersionId}`}>
              提案を見る
            </Link>
          : null}
      {currentStatus === "open" && triage &&
        <small>追加しても修正は完了しません。改定提案と承認が必要です。</small>}
      {currentStatus === "accepted" && <small>対応対象として選択済みです。反映完了ではありません。</small>}
    </footer>

    {dismissOpen && createPortal(<ActionDialog
      open
      onClose={closeDismiss}
      title="この指摘を見送りますか？"
      actions={<DialogActions
        onCancel={closeDismiss}
        onConfirm={() => void submitDismiss()}
        confirmLabel="見送る"
        confirmVariant="danger"
        loading={busy}
        confirmDisabled={!reason.trim()}
      />}
    >
      <p>見送る理由を記録してください。必要になれば再オープンできます。</p>
      <TextArea label="理由" value={reason} onChange={(event) => setReason(event.target.value)} required/>
      {error && <p className="formError" role="alert">{error}</p>}
    </ActionDialog>, document.body)}
  </article>;
}

export default FindingRow;
