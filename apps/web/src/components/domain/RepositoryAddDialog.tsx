"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { isAbortError, LatestRequest } from "../../lib/latest-request.ts";
import { ActionDialog, DialogActions, Select } from "../ui/index.tsx";
import type { InstallationOption } from "./InstallationSelect.tsx";

export function RepositoryAddDialog({
  workspaceId, projectId, installations, onClose, onAdded,
}: {
  workspaceId: string;
  projectId: string;
  installations: InstallationOption[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [installationId, setInstallationId] = useState("");
  const [githubRepoId, setGithubRepoId] = useState("");
  const [repositories, setRepositories] = useState<Array<{ id: string | number; full_name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requests = useRef(new LatestRequest());
  const submittingRef = useRef(false);
  const installation = installations.find((item) => item.id === installationId);
  const selectableInstallations = installations.filter((item) => item.repositorySelection === "selected");

  useEffect(() => {
    requests.current.invalidate();
    setRepositories([]);
    setGithubRepoId("");
    setError(null);
    if (!installation) {
      setRepoLoading(false);
      return;
    }
    const request = requests.current.begin();
    setRepoLoading(true);
    void apiFetch<{ repositories: Array<{ id: string | number; full_name: string }> }>(
      `/api/installations/${installation.githubInstallationId}/repositories`,
      { signal: request.signal },
    ).then((result) => {
      if (request.isCurrent()) setRepositories(result.repositories);
    }).catch((reason: unknown) => {
      if (request.isCurrent() && !isAbortError(reason)) setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    }).finally(() => {
      if (request.isCurrent()) setRepoLoading(false);
    });
    return () => requests.current.invalidate();
  }, [installation]);

  const add = async () => {
    if (submittingRef.current || repoLoading || !installationId || !githubRepoId) return;
    const selectedInstallationId = installationId;
    const selectedGithubRepoId = githubRepoId;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/repositories", {
        method: "POST", workspaceId, body: {
          projectId, installationId: selectedInstallationId, githubRepoId: selectedGithubRepoId,
        },
      });
      onAdded();
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const close = () => { if (!submittingRef.current) onClose(); };

  return <ActionDialog
    open
    onClose={close}
    title="リポジトリを追加"
    error={error}
    actions={<DialogActions
      onCancel={close}
      onConfirm={() => void add()}
      confirmLabel="追加"
      confirmDisabled={repoLoading || !installationId || !githubRepoId}
      loading={submitting}
    />}
  >
    <Select label="GitHub Appのインストール" value={installationId} disabled={submitting}
      onChange={(event) => { setInstallationId(event.target.value); setGithubRepoId(""); }}>
      <option value="">選択してください</option>
      {selectableInstallations.map((item) =>
        <option key={item.id} value={item.id}>{item.accountLogin ?? item.githubInstallationId}</option>)}
    </Select>
    <Select label="リポジトリ" value={githubRepoId} disabled={submitting || repoLoading}
      onChange={(event) => setGithubRepoId(event.target.value)}>
      <option value="">{repoLoading ? "取得中…" : "選択してください"}</option>
      {repositories.map((repository) =>
        <option key={String(repository.id)} value={String(repository.id)}>{repository.full_name}</option>)}
    </Select>
    {!selectableInstallations.length && <p className="formNote">
      利用可能なGitHub Appのインストールがありません。
      <Link href={"/w/" + workspaceId + "/install"}>連携設定を確認</Link>
    </p>}
  </ActionDialog>;
}
