"use client";

import { useState } from "react";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { githubRepositoryUrl } from "../../lib/github-repository-url.ts";
import { ActionDialog, DialogActions, StatusBadge, Table } from "../ui/index.tsx";

export type RepositoryRow = { id: string; fullName: string; defaultBranch?: string; status: string };

function RepositoryIdentity({ repository }: { repository: RepositoryRow }) {
  const url = githubRepositoryUrl(repository.fullName);
  return url
    ? <a className="projectRepoLink" href={url} target="_blank" rel="noopener noreferrer">
        <span>{repository.fullName}</span><ExternalLink size={14} aria-hidden="true"/>
      </a>
    : <strong className="projectRepoName">{repository.fullName}</strong>;
}

function RepositoryActions({ repository, onRequestUnlink, disabled }: {
  repository: RepositoryRow;
  onRequestUnlink: (repository: RepositoryRow) => void;
  disabled: boolean;
}) {
  return <details className="projectRepoMenu">
    <summary aria-label={repository.fullName + " の操作"} aria-disabled={disabled}
      onClick={(event) => { if (disabled) event.preventDefault(); }}>
      <MoreHorizontal size={19} aria-hidden="true"/>
    </summary>
    <div className="projectRepoMenuItems">
      <button type="button" className="projectRepoMenuDanger" disabled={disabled}
        onClick={(event) => {
          event.currentTarget.closest("details")?.removeAttribute("open");
          onRequestUnlink(repository);
        }}>連携を解除</button>
    </div>
  </details>;
}

export function RepositoryTable({
  workspaceId, repositories, canManage, onChanged,
}: {
  workspaceId: string;
  repositories: RepositoryRow[];
  canManage: boolean;
  onChanged?: () => void;
}) {
  const [toRemove, setToRemove] = useState<RepositoryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!busy) {
      setToRemove(null);
      setError(null);
    }
  };
  const unlink = async () => {
    if (!toRemove || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/repositories/" + encodeURIComponent(toRemove.id) +
        "?workspaceId=" + encodeURIComponent(workspaceId), { method: "DELETE" });
      setToRemove(null);
      onChanged?.();
    } catch (reason) {
      setError(getErrorMessage(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"));
    } finally {
      setBusy(false);
    }
  };

  if (!repositories.length) return <div className="projectRepoEmpty">対象リポジトリはまだ登録されていません。</div>;

  return <>
    <div className={"projectRepoDesktop" + (canManage ? " canManage" : "")}>
      <Table>
        <thead><tr>
          <th scope="col">リポジトリ</th>
          <th scope="col">デフォルトブランチ</th>
          <th scope="col">接続状態</th>
          {canManage && <th scope="col">操作</th>}
        </tr></thead>
        <tbody>{repositories.map((repository) => <tr key={repository.id}>
          <td><RepositoryIdentity repository={repository}/></td>
          <td><code className="projectRepoBranch">{repository.defaultBranch ?? "—"}</code></td>
          <td><StatusBadge kind="repositories.status" value={repository.status}/></td>
          {canManage && <td>
            <RepositoryActions repository={repository} disabled={busy} onRequestUnlink={setToRemove}/>
          </td>}
        </tr>)}</tbody>
      </Table>
    </div>

    <div className="projectRepoCards">
      {repositories.map((repository) => <article className="projectRepoMobileCard" key={repository.id}>
        <div className="projectRepoMobileTop">
          <RepositoryIdentity repository={repository}/>
          {canManage && <RepositoryActions repository={repository} disabled={busy} onRequestUnlink={setToRemove}/>}
        </div>
        <div className="projectRepoMobileMeta">
          <span>ブランチ <code>{repository.defaultBranch ?? "—"}</code></span>
          <StatusBadge kind="repositories.status" value={repository.status}/>
        </div>
      </article>)}
    </div>

    {toRemove && <ActionDialog
      open
      onClose={close}
      title="リポジトリの連携を解除"
      actions={<DialogActions
        onCancel={close}
        onConfirm={() => void unlink()}
        confirmLabel="連携を解除"
        confirmVariant="danger"
        loading={busy}
      />}
    >
      <p><strong>{toRemove.fullName}</strong> のプロジェクトへの連携を解除します。</p>
      <p>解析対象から外れます。GitHub上のリポジトリ自体は削除されません。</p>
      {error && <p className="formError" role="alert">{error}</p>}
    </ActionDialog>}
  </>;
}
