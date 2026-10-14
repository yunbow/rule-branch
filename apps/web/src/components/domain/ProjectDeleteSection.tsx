"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { ActionDialog, Button, DialogActions, TextField } from "../ui/index.tsx";

const deleteErrorMessage = (reason: unknown): string => {
  if (!(reason instanceof ApiError)) return getErrorMessage("INTERNAL_ERROR");
  if (reason.code === "PROJECT_NAME_MISMATCH") return "プロジェクト名が一致しません。入力内容を確認してください。";
  if (reason.code === "PROJECT_BUSY") return "実行中の解析または生成処理があります。完了後にもう一度お試しください。";
  return getErrorMessage(reason.code);
};

export function ProjectDeleteSection({
  workspaceId,
  projectId,
  projectName,
  demoMode,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  demoMode: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmName === projectName;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirmName("");
    setError(null);
  };

  const remove = async () => {
    if (!confirmed || busy || demoMode) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/projects/" + encodeURIComponent(projectId), {
        method: "DELETE",
        body: { workspaceId, confirmName },
      });
      router.push("/w/" + encodeURIComponent(workspaceId) + "/projects");
      router.refresh();
    } catch (reason) {
      setError(deleteErrorMessage(reason));
      setBusy(false);
    }
  };

  return <section className="projectDangerZone" aria-labelledby="project-danger-zone-title">
    <div>
      <h2 id="project-danger-zone-title">プロジェクトの削除</h2>
      <p>RuleBranch内からこのプロジェクトを削除し、プロジェクト一覧に表示されないようにします。</p>
      <p>GitHub上のリポジトリ、Pull Request、ソースコードは削除されません。</p>
      {demoMode && <p className="formHint">デモ環境は閲覧専用のため、この操作は利用できません。</p>}
    </div>
    <Button type="button" variant="danger" disabled={demoMode} onClick={() => setOpen(true)}>
      プロジェクトを削除
    </Button>

    <ActionDialog
      open={open}
      onClose={close}
      title="プロジェクトを削除"
      describedBy="project-delete-description"
      actions={<DialogActions
        onCancel={close}
        onConfirm={() => void remove()}
        confirmLabel="削除を確定"
        confirmVariant="danger"
        loading={busy}
        confirmDisabled={!confirmed}
      />}
    >
      <div id="project-delete-description" className="projectDeleteWarning">
        <p><strong>{projectName}</strong> はRuleBranchのプロジェクト一覧から削除されます。この操作は取り消せません。</p>
        <p>このプロジェクトのルール・履歴も表示されなくなります。</p>
        <p>GitHub上のリポジトリ、Pull Request、ソースコードは削除されません。</p>
      </div>
      <TextField
        label={`確認のため「${projectName}」と入力してください`}
        value={confirmName}
        onChange={(event) => setConfirmName(event.target.value)}
        autoComplete="off"
        disabled={busy}
      />
      {error && <p className="formError" role="alert">{error}</p>}
    </ActionDialog>
  </section>;
}
