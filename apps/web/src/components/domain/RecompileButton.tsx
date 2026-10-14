"use client";

import { useCallback, useState } from "react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { canRecompile, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { ActionDialog, Button, DialogActions } from "../ui/index.tsx";
import { JobProgress, type JobView } from "./JobProgress.tsx";

type Result = "done" | "failed" | null;

export function RecompileButton({
  repositoryId, workspaceId, kind, role, onUpdated, hasDraftPr = false,
}: {
  repositoryId: string;
  workspaceId: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  onUpdated?: () => void;
  hasDraftPr?: boolean;
  revisionPrCount?: number; // Kept for compatibility with other callers.
}) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const onComplete = useCallback((completed: JobView) => {
    setActive(false);
    const succeeded = completed.status === "done";
    setResult(succeeded ? "done" : "failed");
    if (!succeeded) {
      setError(completed.error || "生成処理が完了しませんでした。ジョブの状態とエラーを確認してください。");
    }
    onUpdated?.();
  }, [onUpdated]);

  const run = async () => {
    if (submitting || active) return;
    setConfirming(false);
    setSubmitting(true);
    setResult(null);
    setError(null);
    setJob(null);
    try {
      const response = await apiFetch<{ jobId: string }>(
        `/api/repositories/${encodeURIComponent(repositoryId)}`,
        { method: "POST", workspaceId, body: { requestId: crypto.randomUUID() } },
      );
      setJob({ id: response.jobId, type: "compile", status: "queued", attempts: 0 });
      setActive(true);
    } catch (cause) {
      setError(getErrorMessage(cause instanceof ApiError ? cause.code : "INTERNAL_ERROR"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!canRecompile(kind, role)) return <p className="publicationActionUnavailable">
    この操作はメンテナー以上の権限が必要です。
  </p>;

  return <div className="publicationRecompile">
    <Button type="button" variant="secondary" loading={submitting} disabled={active || submitting}
      onClick={() => setConfirming(true)}>
      生成ファイルを作成・更新
    </Button>
    <p className="repositoryMeta">
      {hasDraftPr
        ? "既存のDraft PRが更新される場合があります。内容を確認したうえで実行してください。"
        : "生成処理でDraft PRが作成される場合があります。"}
      マージは自動実行しません。
    </p>
    {job && <JobProgress job={job} workspaceId={workspaceId} compact onDone={onComplete}/>}
    {error && <p role="alert" className="formError">{error}</p>}
    {result === "done" && <p className="publicationResultNotice" role="status">
      生成処理が完了しました。最新のDraft PRと生成物を確認してください。差分や反映完了は、この結果だけでは確定しません。
    </p>}
    <ActionDialog
      open={confirming}
      onClose={() => { if (!submitting) setConfirming(false); }}
      title="生成ファイルを作成・更新しますか？"
      actions={<DialogActions
        onCancel={() => setConfirming(false)}
        onConfirm={() => { void run(); }}
        confirmLabel="生成を開始"
        loading={submitting}
        confirmDisabled={active}
      />}
    >
      <p>現在の承認済みルールから生成ファイルを作成します。</p>
      {hasDraftPr && <p>開いているDraft PRの内容が更新される可能性があります。GitHub上の差分を再確認してください。</p>}
      <p>GitHubへのマージは自動実行しません。</p>
    </ActionDialog>
  </div>;
}
