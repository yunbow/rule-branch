import Link from "next/link";
import { ArrowRight, CheckCircle2, GitBranch, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  type BootstrapStatus,
  type WorkspaceProjectSummary,
} from "../../lib/workspace-overview.ts";
import { Card } from "../ui/index.tsx";

export function ProjectCard({
  workspaceId,
  project,
  canManage = false,
  bootstrapStatus,
  compact = false,
}: {
  workspaceId: string;
  project: WorkspaceProjectSummary;
  canManage?: boolean;
  bootstrapStatus?: BootstrapStatus;
  compact?: boolean;
}) {
  const base = `/w/${workspaceId}/projects/${project.id}`;
  const reviewsBase = `/w/${workspaceId}/reviews`;
  const needsReview = project.humanReviewCount > 0;
  const hasUnreviewed = project.unreviewedCount > 0;
  const hasDrift = project.openDriftCount > 0;
  const hasUnpublished = project.publicationAvailable && project.unpublishedCount > 0;
  const hasCandidates = project.candidateCount > 0;

  const next = needsReview
    ? { href: `${reviewsBase}?status=human_required&project=${encodeURIComponent(project.id)}`, label: "レビューする" }
    : hasUnreviewed
      ? { href: `${reviewsBase}?status=unreviewed&project=${encodeURIComponent(project.id)}`, label: "未評価を確認" }
      : hasDrift
        ? { href: `${base}/drift`, label: "ずれを確認" }
        : hasUnpublished
          ? { href: `${base}/publications`, label: "反映状況を確認" }
          : project.repositoryCount === 0 && canManage
            ? { href: base, label: "リポジトリを追加" }
            : hasCandidates
              ? { href: `${base}/rules`, label: "候補を確認" }
              : bootstrapStatus === "failed" || bootstrapStatus === "running" || bootstrapStatus === "not_started"
                ? { href: `${base}?job=bootstrap`, label: "解析状況を確認" }
                : bootstrapStatus === undefined
                  ? { href: base, label: "解析状況を確認" }
                  : { href: `${base}/rules`, label: "ルールを見る" };

  const hasStatus = needsReview || hasUnreviewed || project.evaluatingCount > 0 ||
    hasDrift || hasUnpublished || hasCandidates || project.publishedCount > 0 ||
    (bootstrapStatus === "failed" && project.repositoryCount > 0);

  return <Card className={`projectOverviewCard${compact ? " projectOverviewCardCompact" : ""}`}>
    <div className="projectCardTop">
      <div className="projectCardIdentity">
        <span className="projectCardIcon" aria-hidden="true"><GitBranch size={18}/></span>
        <div>
          <h3><Link href={base}>{project.name}</Link></h3>
          {project.slug && <p className="projectSlug">{project.slug}</p>}
          {project.description && <p className="projectCardDescription">{project.description}</p>}
        </div>
      </div>
      <Link className="projectCardArrow" href={base} aria-label={`${project.name}の概要を見る`}><ArrowRight size={18}/></Link>
    </div>
    <div className="projectCardMetrics">
      <div><span>リポジトリ</span><strong>{project.repositoryCount}</strong></div>
      <div><span>有効ルール</span><strong>{project.activeRuleCount}</strong></div>
    </div>
    <div className="projectCardStatus" aria-label="プロジェクトの状態">
      {needsReview && <Link className="projectStatus projectStatusWarning" href={`${reviewsBase}?status=human_required&project=${encodeURIComponent(project.id)}`}>
        <TriangleAlert size={14} aria-hidden="true"/>人間確認 {project.humanReviewCount}件
      </Link>}
      {hasUnreviewed && <Link className="projectStatus projectStatusNeutral" href={`${reviewsBase}?status=unreviewed&project=${encodeURIComponent(project.id)}`}>未評価 {project.unreviewedCount}件</Link>}
      {project.evaluatingCount > 0 && <Link className="projectStatus projectStatusInfo" href={`${reviewsBase}?status=evaluating&project=${encodeURIComponent(project.id)}`}>AI評価中 {project.evaluatingCount}件</Link>}
      {bootstrapStatus === "failed" && project.repositoryCount > 0 && <span className="projectStatus projectStatusWarning">初回解析に失敗</span>}
      {hasCandidates && <Link className="projectStatus projectStatusNeutral" href={`${base}/rules`}>候補ルール {project.candidateCount}件</Link>}
      {hasDrift && <Link className="projectStatus projectStatusDrift" href={`${base}/drift`}>未処理Drift {project.openDriftCount}件</Link>}
      {hasUnpublished && <Link className="projectStatus projectStatusWarning" href={`${base}/publications`}>未反映 {project.unpublishedCount}件</Link>}
      {project.publicationAvailable && project.publishedCount > 0 && <Link className="projectStatus projectStatusOk" href={`${base}/publications`}>
        <ShieldCheck size={14} aria-hidden="true"/>反映確認済み {project.publishedCount}件
      </Link>}
      {!hasStatus && (project.repositoryCount === 0
        ? <span className="projectStatus projectStatusNeutral">リポジトリ未登録</span>
        : bootstrapStatus === "failed"
          ? <span className="projectStatus projectStatusWarning">初回解析に失敗</span>
          : bootstrapStatus === "running"
            ? <span className="projectStatus projectStatusInfo">初回解析中</span>
            : bootstrapStatus === "not_started"
              ? <span className="projectStatus projectStatusNeutral">初回解析の記録なし</span>
              : bootstrapStatus === "done" && project.publicationAvailable
              ? <span className="projectStatus projectStatusNeutral"><CheckCircle2 size={14} aria-hidden="true"/>現在の要対応記録なし</span>
              : <span className="projectStatus projectStatusNeutral">解析・反映状況は詳細で確認</span>)}
    </div>
    <div className="projectCardFooter">
      <Link className="projectCardViewLink" href={base}>概要を見る</Link>
      <Link className="projectCardNextAction" href={next.href}>{next.label}<ArrowRight size={15} aria-hidden="true"/></Link>
    </div>
  </Card>;
}
