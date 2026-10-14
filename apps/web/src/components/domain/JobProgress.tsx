"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStatusLabel } from "../../lib/labels.ts";
import { useJobPolling, type PollingJob } from "../../lib/hooks/useJobPolling.ts";
import { elapsedJobSeconds, formatJobDate } from "../../lib/job-presentation.ts";
import { Badge, Spinner, StatusBadge } from "../ui/index.tsx";
import { InjectionWarningBadge } from "./InjectionWarningBadge.tsx";

export type JobWarningView = { code: string; message?: string; path?: string; line?: number };
export type JobView = PollingJob & {
  type: string;
  status: string;
  attempts: number;
  createdAt?: string;
  startedAt?: string | null;
  error?: string | null;
  warnings?: JobWarningView[];
};
const warningLabels: Record<string, string> = {
  output_truncated: "候補数上限で切り捨て",
  evidence_unverifiable: "根拠を検証できず破棄",
  duplicate_rule_key: "重複keyを除外",
  schema_retry: "schema_retry",
};
const timestamp = (value?: string | null) => formatJobDate(value, "medium");

function JobWarnings({ warnings }: { warnings: JobWarningView[] }) {
  return <ul>{warnings.map((warning, index) => <li key={warning.code + "-" + index}>
    {warning.code === "possible_prompt_injection"
      ? <InjectionWarningBadge/>
      : <Badge tone="blue">{warningLabels[warning.code] ?? warning.code}</Badge>}
    {warning.path && <> {warning.path}{warning.line != null ? ":" + warning.line : ""}</>}
    {warning.message ? " " + warning.message : ""}
  </li>)}</ul>;
}

export function JobProgress({
  job: initialJob, workspaceId, onDone, compact = false,
}: {
  job: JobView;
  workspaceId: string;
  onDone?: (job: JobView) => void;
  compact?: boolean;
}) {
  const handleDone = useCallback((completed: PollingJob) => {
    onDone?.({ ...initialJob, ...completed } as JobView);
  }, [initialJob, onDone]);
  const { job: polled } = useJobPolling(initialJob.id, {
    workspaceId, initialStatus: initialJob.status,
    onDone: handleDone,
  });
  const job = (polled ? { ...initialJob, ...polled } : initialJob) as JobView;
  const previous = useRef(job.status);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (previous.current !== job.status) {
      setAnnouncement("ジョブの状態が" + getStatusLabel("analysis_jobs.status", job.status).label + "になりました");
      previous.current = job.status;
    }
  }, [job.status]);
  const type = getStatusLabel("analysis_jobs.type", job.type);
  const active = job.status === "queued" || job.status === "running";
  const start = job.startedAt ?? job.createdAt;
  const [clockNow, setClockNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const update = () => setClockNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = elapsedJobSeconds(start, clockNow);
  const warnings = job.warnings ?? [];

  if (compact) return <section className="projectCompactJobCard" aria-label="ジョブ進捗">
    <div aria-live="polite" className="sr-only">{announcement}</div>
    <div className="projectCompactJobMain">
      <div className="projectCompactJobIdentity">
        <h3>{type.label}</h3>
        <span className="projectCompactJobStatus">
          {active && <Spinner ariaLabel="実行中"/>}
          <StatusBadge kind="analysis_jobs.status" value={job.status}/>
        </span>
      </div>
      <p>
        開始 {timestamp(start)}
        {active && <span> · 経過 {elapsed ?? "—"}秒</span>}
      </p>
    </div>
    {(warnings.length > 0 || job.error) && <details className="projectCompactJobDetails">
      <summary>処理の詳細{warnings.length > 0 ? " · 注意事項" + warnings.length + "件" : ""}</summary>
      <div>
        <p>試行回数：{job.attempts}</p>
        {warnings.length > 0 && <JobWarnings warnings={warnings}/>}
        {job.error && <pre aria-label="エラー詳細">{job.error}</pre>}
      </div>
    </details>}
  </section>;

  return <section className="card" aria-label="ジョブ進捗">
    <div aria-live="polite" className="sr-only">{announcement}</div>
    <h2>{type.label}</h2>
    <p>{active && <Spinner ariaLabel="実行中"/>}<StatusBadge kind="analysis_jobs.status" value={job.status}/></p>
    <p>開始: {timestamp(start)}{active ? "（経過 " + (elapsed ?? "—") + " 秒）" : ""}</p>
    <p>試行回数: {job.attempts}</p>
    {warnings.length > 0 && <div><h3>注意事項</h3><JobWarnings warnings={warnings}/></div>}
    {job.error && <pre aria-label="エラー詳細">{job.error}</pre>}
  </section>;
}
