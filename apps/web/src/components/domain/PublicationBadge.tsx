"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api-client.ts";
import { shortSha } from "../../lib/publication.ts";
import { Popover, Spinner, StatusBadge } from "../ui/index.tsx";

type RepositoryState = { repositoryId: string; state: string; prUrl?: string | null; commitSha?: string | null; verification?: string | null };
export type PublicationState = { aggregate: string; perRepository: RepositoryState[] };

export function PublicationBadge({ versionId, workspaceId, repositories = [], initialState }: { versionId: string; workspaceId: string; repositories?: { id: string; fullName: string }[]; initialState?: PublicationState }) {
  const [state, setState] = useState<PublicationState | null>(initialState ?? null), [error, setError] = useState(false);
  useEffect(() => { if (initialState) { setState(initialState); setError(false); return; } let cancelled = false; setState(null); setError(false); void apiFetch<PublicationState>(`/api/rule-versions/${encodeURIComponent(versionId)}/publication-state`, { workspaceId }).then((value) => { if (!cancelled) setState(value); }).catch(() => { if (!cancelled) setError(true); }); return () => { cancelled = true; }; }, [initialState, versionId, workspaceId]);
  if (error) return <small className="error">公開状態を取得できませんでした</small>;
  if (!state) return <Spinner ariaLabel="公開状態を取得中"/>;
  return <div className="publicationStatus">
    <StatusBadge kind="publicationState" value={state.aggregate}/>
    <Popover>
      <div className="publicationDetails">
        <strong>リポジトリごとの公開状態</strong>
        {state.perRepository.map((item) => <p key={item.repositoryId}>
          {repositories.find((repository) => repository.id === item.repositoryId)?.fullName ?? item.repositoryId}
          {" "}<StatusBadge kind="publicationState" value={item.state}/>
          {item.prUrl && <> <a href={item.prUrl} target="_blank" rel="noopener noreferrer">PRを開く</a></>}
          {item.commitSha && <> commit: {shortSha(item.commitSha)}</>}
          {item.verification && <> <StatusBadge kind="verification" value={item.verification}/></>}
        </p>)}
        <small>UIでの承認が正式承認です。GitHubへのマージは公開処理として別に扱います。</small>
      </div>
    </Popover>
  </div>;
}
