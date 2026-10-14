"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApproveRejectDialog } from "./ApproveRejectDialog.tsx";
import { EvidenceList } from "./EvidenceList.tsx";
import { VersionBody } from "./VersionBody.tsx";
import { VersionDiff } from "./VersionDiff.tsx";
import { InjectionWarningBadge } from "./InjectionWarningBadge.tsx";
import { ApprovalReviewSummary } from "./ApprovalReviewSummary.tsx";
import { Button, ErrorBanner, StatusBadge, useToast } from "../ui/index.tsx";
import { PageSection } from "../ui/Page.tsx";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getStatusLabel } from "../../lib/labels.ts";
import { getVersionReviewPresentation, ruleVersionDetailUrl } from "../../lib/rule-version-detail.ts";

export function VersionDetailClient({
  workspaceId,
  projectId,
  version,
  repositories,
  currentVersionId,
  currentVersionNumber,
  currentContent,
  supersededVersionNumber,
  sourceVersionId,
  canApprove,
  canWrite,
  canWithdraw = false,
}: {
  workspaceId: string;
  projectId?: string;
  version: Record<string, unknown>;
  repositories: { id: string; fullName: string }[];
  currentVersionId: string | null;
  currentVersionNumber: string | null;
  currentContent?: string;
  supersededVersionNumber: string | null;
  sourceVersionId?: string | null;
  canApprove: boolean;
  canWrite: boolean;
  canWithdraw?: boolean;
}) {
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const provenance = version.provenance as Record<string, unknown> | undefined;
  const source = String(provenance?.sourceType ?? "human");
  const supersedes = typeof version.supersedes === "string" ? version.supersedes : sourceVersionId ?? null;
  const ruleId = String(version.ruleId);
  const versionId = String(version.id);
  const ruleHref = "/w/" + workspaceId + (projectId ? "/projects/" + projectId : "") + "/rules/" + ruleId;
  const versionStatus = String(version.status);
  const isProposed = versionStatus === "proposed";
  const summary = typeof version.aiSummary === "string" ? version.aiSummary.trim() : "";
  const rationale = typeof version.rationale === "string" ? version.rationale.trim() : "";
  const changeTypeLabel = getStatusLabel("changeType", String(version.changeType));
  const sourceLabel = getStatusLabel("provenance", source);
  const reviewRecord = getVersionReviewPresentation(version);
  const canCompare = Boolean(currentVersionId && currentVersionId !== versionId && typeof currentContent === "string");
  const [contentView, setContentView] = useState<"diff" | "body">(canCompare ? "diff" : "body");
  const supersedesHref = supersedes
    ? ruleVersionDetailUrl({ workspaceId, projectId, ruleId, versionId: supersedes })
    : null;

  const write = async (action: "approve" | "reject" | "withdraw", body: Record<string, unknown>) => {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/rule-versions/" + encodeURIComponent(versionId) + "/" + action, {
        method: "POST",
        workspaceId,
        body,
      });
      if (action === "approve") {
        toast.add("承認しました");
        router.push(ruleHref + "?approved=1");
      } else {
        setDialog(null);
        router.refresh();
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  };

  return <div className="sectionStack versionDetail">
    {error && !dialog && <ErrorBanner code={error}/>}
    {version.possiblePromptInjection === true && <div className="noticeBanner danger"><InjectionWarningBadge/></div>}

    {(canWrite || (isProposed && canApprove)) && <div className="actionBar versionDetailActions">
      {isProposed && canApprove && <Button type="button" onClick={() => { setError(null); setDialog("approve"); }}>承認</Button>}
      {isProposed && canWrite && <Button type="button" variant="secondary" onClick={() => { setError(null); setDialog("reject"); }}>却下</Button>}
      {canWrite && <Link
        className="button secondary"
        href={ruleHref + "/versions/new?" + (isProposed ? "supersedes=" : "from=") + encodeURIComponent(versionId)}
      >修正版を作成</Link>}
      {isProposed && canWrite && canWithdraw && <Button type="button" variant="danger" loading={loading} onClick={() => void write("withdraw", {})}>取下げ</Button>}
    </div>}

    <PageSection title="今回の変更" description="変更概要、変更種別、作成元と変更理由を確認します。">
      <div className="versionChangeStack">
        {summary && <div className="versionChangeSummary">
          <span className="versionDetailLabel">変更概要</span>
          <p>{summary}</p>
        </div>}
        {source === "human" && supersedes && <p className="versionChangeSubnote">既存のバージョンを人間が修正して作成した版です。</p>}
        <div className="detailMetaGrid">
          <div className="detailMetaItem">
            <span>変更種別</span>
            <div className="versionMetaValue"><strong className="versionMetaText" data-tone={changeTypeLabel.tone}>{changeTypeLabel.label}</strong></div>
          </div>
          <div className="detailMetaItem">
            <span>作成元</span>
            <div className="versionMetaValue"><strong className="versionMetaText" data-tone={sourceLabel.tone}>{sourceLabel.label}</strong></div>
          </div>
          <div className="detailMetaItem">
            <span>元バージョン</span>
            {supersedes && supersedesHref
              ? <div className="versionMetaValue">
                  <Link className="versionMetaLink" href={supersedesHref}>
                    {supersededVersionNumber ? "v" + supersededVersionNumber + " を開く" : "元バージョンを見る"}
                  </Link>
                  <code className="versionReferenceId" title={supersedes}>{supersedes}</code>
                </div>
              : <strong>なし（初回提案）</strong>}
          </div>
        </div>
        <div className="versionChangeReason">
          <h3>変更理由</h3>
          <p>{rationale || "変更理由の記録はありません。"}</p>
        </div>
        <div className="versionCompatibility">
          <Button type="button" variant="ghost" aria-expanded={compatibilityOpen} aria-controls="version-compatibility"
            onClick={() => setCompatibilityOpen(!compatibilityOpen)}>
            互換性情報を{compatibilityOpen ? "閉じる" : "表示"}
          </Button>
          {compatibilityOpen && <div id="version-compatibility" className="contentPanel"><pre>{JSON.stringify(version.compatibility ?? {}, null, 2)}</pre></div>}
        </div>
      </div>
    </PageSection>

    <PageSection title="ルール本文と差分" description="変更後の本文を確認し、現行版がある場合は差分と切り替えられます。">
      {canCompare && <div className="segmentedTabs versionContentTabs" role="tablist" aria-label="ルール内容の表示">
        <Button type="button" variant="ghost" id="version-tab-diff" role="tab" aria-controls="version-panel-diff"
          aria-selected={contentView === "diff"}
          className={contentView === "diff" ? "active" : ""} onClick={() => setContentView("diff")}>現行版との差分</Button>
        <Button type="button" variant="ghost" id="version-tab-body" role="tab" aria-controls="version-panel-body"
          aria-selected={contentView === "body"}
          className={contentView === "body" ? "active" : ""} onClick={() => setContentView("body")}>変更後の全文</Button>
      </div>}
      {canCompare && <div id="version-panel-diff" className="versionContentPanel" role="tabpanel"
        aria-labelledby="version-tab-diff" hidden={contentView !== "diff"}>
        <p className="versionCompareNote">
          比較対象: 現行版{currentVersionNumber ? " v" + currentVersionNumber : ""} → 表示中 v{String(version.version)}
        </p>
        <VersionDiff currentVersionId={currentVersionId} currentContent={currentContent} content={String(version.content)}/>
      </div>}
      <div id={canCompare ? "version-panel-body" : undefined} className="versionContentPanel"
        role={canCompare ? "tabpanel" : undefined} aria-labelledby={canCompare ? "version-tab-body" : undefined}
        hidden={canCompare && contentView !== "body"}>
        {!canCompare && <p className="versionCompareNote">
          {currentVersionId === versionId
            ? "このバージョンが現行版です。変更後の全文を表示します。"
            : currentVersionId ? "比較対象の本文を取得できないため、全文を表示します。" : "比較対象の現行版はありません。"}
        </p>}
        <div className="contentPanel">
          <VersionBody
            content={String(version.content)}
            provenance={provenance}
            automaticallyApproved={(version.approvalReview as Record<string, unknown> | undefined)?.state === "auto_approved"}
          />
        </div>
      </div>
    </PageSection>

    <PageSection title="判断の根拠" description="根拠コードと、解析対象となったコミットを確認します。">
      <EvidenceList
        workspaceId={workspaceId}
        evidenceIds={Array.isArray(version.evidenceIds) ? version.evidenceIds as string[] : []}
        repositories={repositories}
      />
    </PageSection>

    <PageSection title="自動評価・承認判定" description="AI評価を利用した場合のスコアと、人間確認になった理由です。">
      {version.approvalReview
        ? <ApprovalReviewSummary version={version} workspaceId={workspaceId}/>
        : <div className="reviewEvaluationSummary reviewEvaluationPending"><p><strong>自動評価結果なし</strong> このバージョンには自動評価の記録がありません。</p></div>}
    </PageSection>

    <PageSection title="関連するDrift">
      {projectId && Array.isArray(version.driftFindingIds) && version.driftFindingIds.length
        ? <div className="inlineActions">{version.driftFindingIds.map((id) =>
            <Link className="button secondary" key={String(id)} href={"/w/" + workspaceId + "/projects/" + projectId + "/drift"}>
              {String(id)}
            </Link>
          )}</div>
        : <p className="formNote">関連するDriftはありません。</p>}
    </PageSection>

    <PageSection title="レビュー記録">
      <div className="versionReviewStatus">
        <StatusBadge kind="rule_versions.status" value={versionStatus}/>
        <span>{reviewRecord.message}</span>
      </div>
      {reviewRecord.method && <div className="detailMetaGrid versionReviewGrid">
        <div className="detailMetaItem"><span>承認方式</span><strong>{reviewRecord.method}</strong></div>
        {reviewRecord.approvedBy && <div className="detailMetaItem"><span>承認者</span><strong>{reviewRecord.approvedBy}</strong></div>}
        {reviewRecord.approvedAt && <div className="detailMetaItem"><span>承認日時</span><strong>{reviewRecord.approvedAt}</strong></div>}
      </div>}
      {reviewRecord.kind === "rejected" && <div className="versionChangeReason versionRejectionReason">
        <h3>却下理由</h3>
        <p>{reviewRecord.rejectionReason || "却下理由の記録はありません。"}</p>
      </div>}
    </PageSection>

    {dialog && <ApproveRejectDialog
      mode={dialog}
      open
      loading={loading}
      error={error}
      onClose={() => setDialog(null)}
      onSubmit={(value) => void write(
        dialog,
        dialog === "approve" ? { comment: value } : { reason: value },
      )}
    />}
  </div>;
}
