"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../api-client.ts";
import { isAbortError, LatestRequest } from "../latest-request.ts";
import { isActiveJobStatus, mergeProjectJobs, shouldPollJob, shouldPollProjectJobs } from "./job-polling-policy.ts";

export { isActiveJobStatus, mergeProjectJobs, shouldPollJob, shouldPollProjectJobs } from "./job-polling-policy.ts";

export type PollingJob = { id: string; status: string; [key: string]: unknown };
export function useJobPolling(jobId: string, options: { intervalMs?: number; onDone?: (job: PollingJob) => void; workspaceId?: string; initialStatus?: string; enabled?: boolean } = {}) {
  const { intervalMs = 3000, onDone, workspaceId, initialStatus = "queued", enabled = true } = options, router = useRouter();
  const [job, setJob] = useState<PollingJob | null>(null), [error, setError] = useState<string | null>(null), [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const requests = useRef(new LatestRequest());
  const notifiedTerminal = useRef<string | null>(null);
  const status = job?.status ?? initialStatus;
  const refresh = useCallback(async () => {
    const request = requests.current.begin();
    try {
      const next = await apiFetch<PollingJob>(`/api/jobs/${encodeURIComponent(jobId)}`, { workspaceId, signal: request.signal });
      if (!request.isCurrent()) return;
      setJob(next); setError(null);
      if (!isActiveJobStatus(next.status)) {
        const terminalKey = `${jobId}:${next.status}`;
        if (notifiedTerminal.current !== terminalKey) {
          notifiedTerminal.current = terminalKey;
          onDone?.(next);
          router.refresh();
        }
      }
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason)) setError(reason instanceof Error ? reason.message : "INTERNAL_ERROR");
    }
  }, [jobId, onDone, router, workspaceId]);
  useEffect(() => {
    requests.current.invalidate();
    notifiedTerminal.current = null;
    setJob(null);
    setError(null);
    return () => requests.current.invalidate();
  }, [jobId, workspaceId]);
  useEffect(() => { const update = () => setHidden(document.hidden); update(); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  useEffect(() => { if (!shouldPollJob(status, hidden, enabled)) return; let cancelled = false, timer: number | undefined; const poll = async () => { await refresh(); if (!cancelled) timer = window.setTimeout(() => { void poll(); }, intervalMs); }; void poll(); return () => { cancelled = true; requests.current.invalidate(); if (timer !== undefined) window.clearTimeout(timer); }; }, [enabled, hidden, intervalMs, refresh, status]);
  return { job, error, polling: shouldPollJob(status, hidden, enabled) };
}

export function useProjectJobsPolling<T extends PollingJob>(projectId: string, initialJobs: readonly T[], options: { intervalMs?: number; workspaceId: string; excludedJobId?: string } ) {
  const { intervalMs = 3000, workspaceId, excludedJobId } = options, router = useRouter();
  const [jobs, setJobs] = useState<T[]>(() => [...initialJobs]), [error, setError] = useState<string | null>(null), [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const requests = useRef(new LatestRequest());
  const polling = shouldPollProjectJobs(jobs, hidden, excludedJobId);
  useEffect(() => { setJobs([...initialJobs]); }, [initialJobs]);
  useEffect(() => {
    requests.current.invalidate();
    setJobs([...initialJobs]);
    setError(null);
    return () => requests.current.invalidate();
  }, [projectId, workspaceId]);
  useEffect(() => { const update = () => setHidden(document.hidden); update(); document.addEventListener("visibilitychange", update); return () => document.removeEventListener("visibilitychange", update); }, []);
  const refresh = useCallback(async () => {
    const request = requests.current.begin();
    try {
      const response = await apiFetch<{ jobs: T[] }>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, { workspaceId, signal: request.signal });
      if (!request.isCurrent()) return;
      setJobs((current) => mergeProjectJobs(current, response.jobs));
      setError(null);
      if (!shouldPollProjectJobs(response.jobs, false, excludedJobId)) router.refresh();
    } catch (reason) {
      if (request.isCurrent() && !isAbortError(reason)) setError(reason instanceof Error ? reason.message : "INTERNAL_ERROR");
    }
  }, [excludedJobId, projectId, router, workspaceId]);
  useEffect(() => {
    if (!polling) return;
    let cancelled = false, timer: number | undefined;
    const poll = async () => { await refresh(); if (!cancelled) timer = window.setTimeout(() => { void poll(); }, intervalMs); };
    void poll();
    return () => { cancelled = true; requests.current.invalidate(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [intervalMs, polling, refresh]);
  return { jobs, error, polling };
}
