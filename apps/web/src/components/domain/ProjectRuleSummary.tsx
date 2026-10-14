import Link from "next/link";
import { ArrowUpRight, CircleCheck, ClipboardList, CloudUpload, ShieldAlert } from "lucide-react";
import { PageSection } from "../ui/Page.tsx";

export function ProjectRuleSummary({
  workspaceId, projectId, counts, totalRules, draftPrCount,
}: {
  workspaceId: string;
  projectId: string;
  counts: { candidates: number; stale: number; unpublished: number; published: number };
  totalRules: number;
  draftPrCount: number;
}) {
  const base = "/w/" + workspaceId + "/projects/" + projectId;
  const metrics = [
    {
      label: "候補ルール", value: counts.candidates, href: base + "/rules?tab=draft",
      description: "本文と根拠を確認", tone: "candidate", icon: <ClipboardList size={19}/>,
    },
    {
      label: "要確認ルール", value: counts.stale, href: base + "/rules?tab=stale",
      description: "コードとのずれを確認", tone: "stale", icon: <ShieldAlert size={19}/>,
    },
    {
      label: "承認済み・未反映", value: counts.unpublished, href: base + "/publications",
      description: "PR・反映検証を確認",
      tone: "unpublished", icon: <CloudUpload size={19}/>,
    },
    {
      label: "反映確認済み", value: counts.published, href: base + "/publications",
      description: "GitHubへの反映結果", tone: "published", icon: <CircleCheck size={19}/>,
    },
  ];

  return <PageSection
    title={<span className="projectRuleSummaryTitle">ルールの状況 <span>全{totalRules}件</span></span>}
    actions={draftPrCount > 0
      ? <Link href={base + "/publications"} className="projectDraftPrLink">
          Draft PR <strong>{draftPrCount}件</strong> <ArrowUpRight size={14} aria-hidden="true"/>
        </Link>
      : undefined}
    className="projectRuleSummarySection">
    <div className="projectMetricGrid">
      {metrics.map((metric) => <Link
        key={metric.label}
        href={metric.href}
        className={"projectMetricLink" + (metric.value > 0 ? " hasItems " + metric.tone : "")}
        aria-label={metric.label + " " + metric.value + "件。 " + metric.description}
      >
        <div className="projectMetricCard">
          <div className="projectMetricTop">
            <span className="projectMetricIcon" aria-hidden="true">{metric.icon}</span>
            <ArrowUpRight size={17} className="projectMetricArrow" aria-hidden="true"/>
          </div>
          <p>{metric.label}</p>
          <strong>{metric.value}<small>件</small></strong>
          <span className="projectMetricDescription">{metric.description}</span>
        </div>
      </Link>)}
    </div>
    <p className="projectMetricFootnote">
      状況は重複する場合があります。反映確認済みは対象リポジトリへの反映結果であり、AIによるルール遵守を示す値ではありません。
    </p>
  </PageSection>;
}
