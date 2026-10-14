"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, ChevronDown, FileCheck2 } from "lucide-react";
import { getStatusLabel } from "../../lib/labels.ts";
import { formatDecisionDate, type DecisionMemoryRecord } from "../../lib/decision-memory.ts";
import { DecisionPublicationStatus } from "./DecisionPublicationStatus.tsx";

export type DecisionMemoryView = DecisionMemoryRecord;
export type DecisionRuleLink = { title: string; href: string };

export function DecisionMemoryCard({
  memory, rulesById = {}, workspaceId, projectId,
}: {
  memory: DecisionMemoryView;
  rulesById?: Record<string, DecisionRuleLink>;
  workspaceId: string;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const versionRuleId = memory.linkedRuleIds.find((id) =>
    Object.prototype.hasOwnProperty.call(rulesById, id));
  const approvedVersion = memory.approvedRuleVersionId;
  const approvedVersionHref = approvedVersion && versionRuleId
    ? `/w/${workspaceId}/projects/${projectId}/rules/${encodeURIComponent(versionRuleId)}/versions/${encodeURIComponent(approvedVersion)}`
    : null;
  const validDate = Boolean(memory.createdAt && Number.isFinite(Date.parse(memory.createdAt)));
  const changeType = memory.approvedChangeType
    ? getStatusLabel("changeType", memory.approvedChangeType).label : null;
  const hasStructuredApproval = Boolean(memory.approvedChangeType || memory.approvalComment);

  return <article className="decisionRecordCard" id={`decision-${memory.id}`}>
    <header className="decisionRecordHeader">
      <div className="decisionRecordHeading">
        <span className="decisionRecordKind"><FileCheck2 size={15} aria-hidden="true"/>
          {memory.approvalMode === "automatic" ? "自動承認" :
            memory.approvalMode === "human" ? "人間が承認" : "ルール承認"}</span>
        <h3>{memory.title}</h3>
      </div>
      {validDate && <time dateTime={memory.createdAt}>{formatDecisionDate(memory.createdAt)}</time>}
    </header>

    <div className="decisionRecordSummary">
      <span>判断理由</span>
      <p className={expanded ? "expanded" : undefined}>{memory.decision || "判断理由は記録されていません。"}</p>
    </div>

    {memory.linkedRuleIds.length > 0 && <div className="decisionRecordRules">
      <span>関連ルール</span>
      <div>{memory.linkedRuleIds.map((id) => {
        const related = rulesById[id];
        return related
          ? <Link key={id} className="decisionRecordRuleLink" href={related.href}>
              {related.title}<ArrowUpRight size={13} aria-hidden="true"/>
            </Link>
          : <span className="decisionRecordUnavailable" key={id} title={id}>
              過去の関連ルール（現在は確認不可）
            </span>;
      })}</div>
    </div>}

    <details className="decisionRecordDetails"
      onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>背景・承認内容・根拠を確認 <ChevronDown size={16} aria-hidden="true"/></summary>
      <div className="decisionRecordDetailsBody">
        <dl className="decisionRecordFacts">
          <div><dt>承認の背景</dt><dd>{memory.context || "背景は記録されていません。"}</dd></div>
          <div><dt>承認内容・コメント</dt><dd>
            {hasStructuredApproval
              ? <>
                  {changeType && <p><strong>変更種別：</strong>{changeType}</p>}
                  {memory.approvalComment && <p><strong>承認コメント：</strong>{memory.approvalComment}</p>}
                </>
              : (memory.consequences || "承認内容は記録されていません。")}
          </dd></div>
          {memory.approvalMode === "automatic" && <div><dt>自動承認の補足</dt><dd>{memory.consequences}</dd></div>}
          {memory.linkedEvidenceIds && memory.linkedEvidenceIds.length > 0 &&
            <div><dt>紐づく根拠</dt><dd>{memory.linkedEvidenceIds.length}件
              {approvedVersionHref && <> — <Link href={approvedVersionHref}>承認版の根拠を確認</Link></>}
            </dd></div>}
        </dl>
        <div className="decisionRecordNextLinks">
          {approvedVersionHref
            ? <Link className="decisionRecordVersionLink" href={approvedVersionHref}>
                承認された版を見る <ArrowUpRight size={15} aria-hidden="true"/>
              </Link>
            : <p className="decisionRecordHistoricalNote">
                承認版への直接リンクは利用できません。旧形式の記録、または関連ルールが現在参照できない可能性があります。
              </p>}
          {expanded && (approvedVersion && approvedVersionHref
            ? <DecisionPublicationStatus versionId={approvedVersion}
                workspaceId={workspaceId} projectId={projectId}/>
            : <div className="decisionPublicationState">
                <p>この記録の版別GitHub反映状態は判定できません。</p>
                <Link href={`/w/${workspaceId}/projects/${projectId}/publications`}>
                  プロジェクトの反映状況を見る →
                </Link>
              </div>)}
        </div>
      </div>
    </details>
  </article>;
}
