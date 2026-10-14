"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "../../lib/api-client.ts";
import { getErrorMessage, PROPOSAL_REGENERATE_CONFIRMATION } from "../../lib/messages.ts";
import { useJobPolling, type PollingJob } from "../../lib/hooks/useJobPolling.ts";
import { ActionDialog, Button, DialogActions, ErrorBanner } from "../ui/index.tsx";
import { JobProgress, type JobView } from "./JobProgress.tsx";
type FindingResponse = { driftFindings: Array<{ id: string; proposalVersionId?: string | null }> };
function ProposalJob({ job, workspaceId, onFinished }: { job: JobView; workspaceId: string; onFinished: (job: PollingJob) => void }) { useJobPolling(job.id, { workspaceId, initialStatus: job.status, onDone: onFinished }); return <JobProgress job={job} workspaceId={workspaceId}/>; }
export function ProposalGenerateButton({ findingId, ruleId, proposalVersionId, workspaceId, projectId }: { findingId: string; ruleId: string; proposalVersionId?: string | null; workspaceId: string; projectId: string }) {
  const router = useRouter(), [job, setJob] = useState<JobView | null>(null), [terminalJob, setTerminalJob] = useState<JobView | null>(null), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [error, setError] = useState<string | null>(null), [noProposal, setNoProposal] = useState(false), [disabled, setDisabled] = useState(false);
  const start = async () => { setBusy(true); setError(null); setNoProposal(false); setTerminalJob(null); try { const result = await apiFetch<{ jobId: string }>(`/api/drift-findings/${encodeURIComponent(findingId)}/proposals`, { method: "POST", workspaceId, body: { requestId: crypto.randomUUID() } }); setJob({ id: result.jobId, type: "proposal", status: "queued", attempts: 0 }); } catch (cause) { const code = cause instanceof ApiError ? cause.code : "INTERNAL_ERROR"; setError(getErrorMessage(code)); setDisabled(code === "AI_AUTO_PROPOSAL_DISABLED"); } finally { setBusy(false); } };
  const finished = useCallback(async (finishedJob: PollingJob) => { if (finishedJob.status !== "done") { setJob(null); setTerminalJob({ ...finishedJob, type: "proposal", attempts: typeof finishedJob.attempts === "number" ? finishedJob.attempts : 0 } as JobView); setError(typeof finishedJob.error === "string" ? finishedJob.error : "提案生成に失敗しました"); return; } try { const response = await apiFetch<FindingResponse>("/api/drift-findings", { workspaceId }); const finding = response.driftFindings.find(item => item.id === findingId); if (finding?.proposalVersionId) router.push(`/w/${workspaceId}/projects/${projectId}/rules/${ruleId}/versions/${finding.proposalVersionId}`); else { setNoProposal(true); setJob(null); } } catch (cause) { setJob(null); setError(getErrorMessage(cause instanceof ApiError ? cause.code : "INTERNAL_ERROR")); } }, [findingId, projectId, router, ruleId, workspaceId]);
  if (job) return <ProposalJob job={job} workspaceId={workspaceId} onFinished={finished}/>;
  return <div>{terminalJob && <JobProgress job={terminalJob} workspaceId={workspaceId}/>} {proposalVersionId ? <><Link href={`/w/${workspaceId}/projects/${projectId}/rules/${ruleId}/versions/${proposalVersionId}`}>提案を見る</Link><Button type="button" loading={busy} disabled={disabled} onClick={() => setConfirming(true)}>再生成</Button></> : <Button type="button" loading={busy} disabled={disabled} onClick={() => void start()}>提案を生成</Button>}{noProposal && <p>根拠を検証できず提案は作成されませんでした</p>}{error && <ErrorBanner code="INTERNAL_ERROR" details={error}/>}<ActionDialog
    open={confirming}
    onClose={() => setConfirming(false)}
    title="提案を再生成しますか？"
    actions={<DialogActions
      onCancel={() => setConfirming(false)}
      onConfirm={() => { setConfirming(false); void start(); }}
      confirmLabel="再生成"
      loading={busy}
    />}
  >
    <p>{PROPOSAL_REGENERATE_CONFIRMATION}</p>
</ActionDialog></div>;
}
