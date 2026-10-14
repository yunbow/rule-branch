"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { ActionDialog, Button, Checkbox, DialogActions, Select, Spinner, useToast } from "../ui/index.tsx";

type Workspace = { id: string; name: string };
type MeResponse = { user: { id: string }; workspaces: Workspace[] };

/** Account deletion is self-service only (security fix, P0): a Workspace admin can remove
 * a member's membership but never another person's global RuleBranch account, so there is
 * deliberately no "target user" input here. */
export function PurgeRequestDialog() {
  const { add: toast } = useToast();
  const [open, setOpen] = useState(false), [me, setMe] = useState<MeResponse | null>(null), [workspaceId, setWorkspaceId] = useState(""), [confirmed, setConfirmed] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open || me) return; let active = true; void apiFetch<MeResponse>("/api/me").then((value) => { if (active) { setMe(value); setWorkspaceId(value.workspaces[0]?.id ?? ""); } }).catch((reason: unknown) => { if (active) setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"); }); return () => { active = false; }; }, [open, me]);
  const close = () => { if (!loading) { setOpen(false); setConfirmed(false); setError(null); } };
  const submit = async () => {
    if (!me || !workspaceId || !confirmed) return;
    setLoading(true); setError(null);
    try {
      const result = await apiFetch<{ jobId: string }>("/api/data-subject-requests", { method: "POST", body: { ownerWorkspaceId: workspaceId, requestId: crypto.randomUUID() } });
      toast(`要求を受け付けました(ジョブ ID: ${result.jobId})`); setOpen(false); setConfirmed(false);
    } catch (reason) { setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"); } finally { setLoading(false); }
  };
  return <>
    <Button type="button" variant="danger" onClick={() => setOpen(true)}>データ削除を要求</Button>
    <ActionDialog
      open={open}
      onClose={close}
      title="アカウントデータの削除を要求"
      error={error}
      actions={<DialogActions
        onCancel={close}
        onConfirm={() => void submit()}
        confirmLabel="要求を送信"
        confirmVariant="danger"
        loading={loading}
        confirmDisabled={!me || !workspaceId || !confirmed}
      />}
    >
      <p>削除は不可逆です。ご自身のアカウントデータの削除ジョブを要求します（他ユーザーの代理削除はできません。Workspaceからメンバーを除名する場合はメンバー管理画面を使用してください）。</p>
      {!me && !error && <Spinner/>}
      {me && <>
        <Select label="Workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
          {me.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Checkbox label="削除の影響と不可逆性を理解しました" checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}/>
      </>}
    </ActionDialog>
  </>;
}
