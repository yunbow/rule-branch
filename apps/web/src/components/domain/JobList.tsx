"use client";

import { useId, useMemo, useState } from "react";
import { getStatusLabel } from "../../lib/labels.ts";
import { useProjectJobsPolling } from "../../lib/hooks/useJobPolling.ts";
import { formatJobDate } from "../../lib/job-presentation.ts";
import { EmptyState, ErrorBanner, Spinner, StatusBadge, Table } from "../ui/index.tsx";
import type { JobView } from "./JobProgress.tsx";

const INITIAL_VISIBLE = 5;
const MAX_JOBS = 20;
const formatDate = (value?: string) => formatJobDate(value, "short");

function JobDetails({ job }: { job: JobView }) {
  return <div className="jobDetails">
    <p>試行回数：{job.attempts}</p>
    <p>開始日時：{formatDate(job.startedAt ?? undefined)}</p>
    {job.error && <p className="jobDetailsError">エラー：{job.error}</p>}
    {job.warnings?.length ? <ul>{job.warnings.map((warning, index) =>
      <li key={warning.code + "-" + index}>{warning.message || warning.code}</li>)}</ul> : null}
  </div>;
}

function JobRow({ job }: { job: JobView }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const active = job.status === "queued" || job.status === "running";
  return <>
    <tr>
      <td>{getStatusLabel("analysis_jobs.type", job.type).label}</td>
      <td>{active && <Spinner ariaLabel="実行中"/>}<StatusBadge kind="analysis_jobs.status" value={job.status}/></td>
      <td>{formatDate(job.createdAt)}</td>
      <td><button className="jobDetailToggle" type="button" aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        onClick={() => setExpanded(!expanded)}>{expanded ? "閉じる" : "詳細"}</button></td>
    </tr>
    {expanded && <tr className="expandedTableRow" id={detailId}><td colSpan={4}>
      <div className="expandedTableContent"><JobDetails job={job}/></div>
    </td></tr>}
  </>;
}

function JobMobileCard({ job }: { job: JobView }) {
  const active = job.status === "queued" || job.status === "running";
  return <details className="projectJobMobileCard">
    <summary>
      <span className="projectJobMobileTitle">{getStatusLabel("analysis_jobs.type", job.type).label}</span>
      <span className="projectJobMobileStatus">
        {active && <Spinner ariaLabel="実行中"/>}
        <StatusBadge kind="analysis_jobs.status" value={job.status}/>
      </span>
      <time className="projectJobMobileDate">{formatDate(job.createdAt)}</time>
      <span className="projectJobMobileDisclosure">詳細</span>
    </summary>
    <div className="projectJobMobileDetails"><JobDetails job={job}/></div>
  </details>;
}

export function JobList({
  jobs, workspaceId, projectId, externallyPolledJobId,
}: {
  jobs: JobView[];
  workspaceId: string;
  projectId: string;
  externallyPolledJobId?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const initialJobs = useMemo(() => jobs.slice(0, MAX_JOBS), [jobs]);
  const { jobs: polledJobs, error } = useProjectJobsPolling(projectId, initialJobs, {
    workspaceId, excludedJobId: externallyPolledJobId,
  });
  const recent = polledJobs.slice(0, showAll ? MAX_JOBS : INITIAL_VISIBLE);
  const hasMore = polledJobs.length > INITIAL_VISIBLE;

  return <>
    {error && <ErrorBanner code={error}/>}
    {recent.length ? <>
      <div className="projectJobsDesktop">
        <Table>
          <thead><tr><th>処理</th><th>状態</th><th>作成日時</th><th>詳細</th></tr></thead>
          <tbody>{recent.map((job) => <JobRow key={job.id} job={job}/>)}</tbody>
        </Table>
      </div>
      <div className="projectJobMobileCards">
        {recent.map((job) => <JobMobileCard key={job.id} job={job}/>)}
      </div>
      {hasMore && <div className="projectJobHistoryFooter">
        <span>{Math.min(polledJobs.length, MAX_JOBS)}件中 {recent.length}件を表示</span>
        <button type="button" className="projectJobShowMore" aria-expanded={showAll}
          onClick={() => setShowAll((current) => !current)}>
          {showAll ? "5件に戻す" : "さらに" + (Math.min(polledJobs.length, MAX_JOBS) - INITIAL_VISIBLE) + "件を表示"}
        </button>
      </div>}
    </> : <EmptyState>処理履歴はありません。</EmptyState>}
  </>;
}
