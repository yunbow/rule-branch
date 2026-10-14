"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { EmptyState, ErrorBanner, Spinner } from "../ui/index.tsx";

type Evidence = Record<string, unknown>;
type Repository = { id: string; fullName: string };

export function EvidenceList({
  workspaceId,
  evidenceIds,
  repositories,
  onRemove,
}: {
  workspaceId: string;
  evidenceIds: string[];
  repositories: Repository[];
  onRemove?: (id: string) => void;
}) {
  const [items, setItems] = useState<Evidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idsKey = evidenceIds.join(",");
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!evidenceIds.length) {
      setItems([]);
      return;
    }
    setItems(null);
    apiFetch<{ evidence: Evidence[] }>(`/api/evidence?ids=${encodeURIComponent(idsKey)}`, { workspaceId })
      .then((result) => { if (!cancelled) setItems(result.evidence); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
      });
    return () => { cancelled = true; };
  }, [workspaceId, idsKey]);

  if (!evidenceIds.length) return <EmptyState>根拠はありません。</EmptyState>;
  if (error) return <ErrorBanner code={error}/>;
  if (!items) return <div className="loadingState"><Spinner/></div>;

  const selected: Evidence[] = evidenceIds.map((id) =>
    items.find((item) => String(item.id) === id) ?? { id, _unavailable: true },
  );

  return <div className="cardList">
    {selected.map((evidence) => {
      if (evidence._unavailable === true) {
        return <article className="evidenceCard" key={String(evidence.id)}>
          <header className="evidenceSelectionHeader">
            <div>
              <strong>根拠を取得できませんでした</strong>
              <span>ID: {String(evidence.id)}</span>
            </div>
            {onRemove && <button type="button" className="evidenceRemoveAction" onClick={() => onRemove(String(evidence.id))}>紐付けを外す</button>}
          </header>
          <p className="formNote">根拠を確認できないため、参照コードは表示していません。必要に応じて紐付けを見直してください。</p>
        </article>;
      }
      const ref = evidence.ref as Record<string, unknown> | undefined;
      const path = String(ref?.path ?? evidence.path ?? "");
      const start = Number(ref?.lineStart ?? evidence.lineStart ?? 0);
      const end = Number(ref?.lineEnd ?? evidence.lineEnd ?? 0);
      const sha = String(evidence.commitSha ?? ref?.commitSha ?? "");
      const state = String(evidence.excerptState ?? "none");
      const fullName = repositories.find((repository) => repository.id === String(evidence.repositoryId))?.fullName;
      const lineAnchor = start > 0 ? `#L${start}${end > start ? `-L${end}` : ""}` : "";
      const href = fullName && sha && path
        ? `https://github.com/${fullName}/blob/${sha}/${path}${lineAnchor}`
        : undefined;

      return <article className="evidenceCard" key={String(evidence.id)}>
        <header className="evidenceSelectionHeader">
          <div>
            <strong>{String(evidence.label ?? evidence.kind ?? "Evidence")}</strong>
            <span>{fullName ? `${fullName} · ` : ""}{path}{start ? ` L${start}${end > start ? `-L${end}` : ""}` : ""}{sha ? ` · ${sha.slice(0, 7)}` : ""}</span>
          </div>
          {onRemove && <button type="button" className="evidenceRemoveAction" onClick={() => onRemove(String(evidence.id))}>紐付けを外す</button>}
        </header>
        {state === "present" && <pre>{String(evidence.excerpt ?? "")}</pre>}
        {state === "present" && href && <div className="evidenceActions"><a href={href} target="_blank" rel="noopener noreferrer">このコミットのコードを開く</a></div>}
        {state === "purged" && href &&
          <a href={href} target="_blank" rel="noopener noreferrer">保存期間満了のため抜粋は削除済みです。GitHub上の該当箇所を開く</a>}
        {state === "none" && href &&
          <a href={href} target="_blank" rel="noopener noreferrer">GitHub上の該当箇所を開く</a>}
      </article>;
    })}
  </div>;
}
