"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { countDriftStatus, formatDriftDate } from "../../lib/drift-presentation.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../shared/permissions.ts";
import { FindingRow, type FindingView } from "./FindingRow.tsx";

type Rule = { id: string; title: string; staleSince?: string | null };

export function StaleRuleRow({
  rule, findings, visibleFindings, workspaceId, projectId, workspaceKind, role, repositories,
}: {
  rule: Rule;
  findings: FindingView[];
  visibleFindings?: FindingView[];
  workspaceId: string;
  projectId: string;
  workspaceKind: WorkspaceKind;
  role: WorkspaceRole;
  repositories: { id: string; fullName: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const counts = countDriftStatus(findings);
  const shown = visibleFindings ?? findings;
  const ruleUrl = `/w/${workspaceId}/projects/${projectId}/rules/${rule.id}`;
  const date = formatDriftDate(rule.staleSince ?? undefined);

  return <section className="driftRuleCard" aria-label={rule.title}>
    <div className="driftRuleCardTop">
      <div className="driftRuleCardCopy">
        <Link className="driftRuleCardTitle" href={ruleUrl}>{rule.title}</Link>
        <div className="driftRuleCardMetadata">
          <span>要確認開始 {date}</span>
          <span>未処理 <strong>{counts.open}件</strong></span>
          <span>対応中 <strong>{counts.accepted}件</strong></span>
        </div>
      </div>
      <button type="button" className="driftRuleCardExpand"
        aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
        onClick={() => setExpanded((current) => !current)}>
        {expanded ? "指摘を閉じる" : "関連指摘 " + shown.length + "件"}
        <ChevronDown size={16} aria-hidden="true"/>
      </button>
    </div>
    {expanded && <div className="driftRuleCardDetails" id={detailsId}>
      <h3>関連する指摘 <span>{shown.length}件</span></h3>
      {shown.length
        ? <div className="driftFindingList">{shown.map((finding) =>
            <FindingRow key={finding.id} finding={finding} ruleTitle={rule.title} showRuleLink={false}
              workspaceId={workspaceId} projectId={projectId}
              workspaceKind={workspaceKind} role={role} repositories={repositories}/>)}</div>
        : <p className="driftInlineEmpty">表示条件に一致する指摘はありません。</p>}
    </div>}
  </section>;
}

export default StaleRuleRow;
