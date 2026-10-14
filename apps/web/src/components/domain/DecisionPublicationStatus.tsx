"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { Spinner, StatusBadge } from "../ui/index.tsx";

type PublicationState = {
  aggregate: string;
  perRepository?: Array<{ repositoryId: string; state: string }>;
};

/**
 * Loaded only when a decision card is expanded, so the history view never
 * creates one network request per row. Represents current publication state,
 * not proof that an agent obeyed the rule or a historical snapshot.
 */
export function DecisionPublicationStatus({
  versionId, workspaceId, projectId,
}: {
  versionId: string;
  workspaceId: string;
  projectId: string;
}) {
  const [state, setState] = useState<PublicationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setState(null);
    void apiFetch<PublicationState>(
      `/api/rule-versions/${encodeURIComponent(versionId)}/publication-state`,
      { workspaceId },
    ).then((value) => {
      if (!cancelled) setState(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(getErrorMessage(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"));
    });
    return () => { cancelled = true; };
  }, [versionId, workspaceId]);

  return <div className="decisionPublicationState" aria-label="承認版のGitHub反映状況">
    <div className="decisionPublicationStateHeader">
      <strong>GitHubへの反映（現在の状態）</strong>
      {state
        ? <StatusBadge kind="publicationState" value={state.aggregate}/>
        : error
          ? <span className="formError" role="alert">取得できませんでした</span>
          : <Spinner ariaLabel="反映状況を取得中"/>}
    </div>
    <p>承認とGitHubへの反映は別です。反映状態は現在の記録であり、AIによるルール遵守や承認当時の状態を示しません。</p>
    <Link href={`/w/${workspaceId}/projects/${projectId}/publications`}>リポジトリ別の反映状況を見る →</Link>
  </div>;
}
