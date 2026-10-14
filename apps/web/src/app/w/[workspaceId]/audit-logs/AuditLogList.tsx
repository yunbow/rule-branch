"use client";
import { useState } from "react";
import { apiFetch, ApiError } from "../../../../lib/api-client.ts";
import type { AuditLogPage } from "../../../../shared/audit-logs.ts";
import { Button, EmptyState, ErrorBanner } from "../../../../components/ui/index.tsx";
import "./audit-logs.css";

const actorLabels: Record<string, string> = { user: "ユーザー", ai: "AI", system: "システム", github: "GitHub" };
export function AuditLogList({ workspaceId, initial }: { workspaceId: string; initial: AuditLogPage }) {
  const [result, setResult] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (append: boolean) => {
    if (loading) return;
    setLoading(true); setError(null);
    try {
      const query = new URLSearchParams();
      if (append && result.nextCursor) query.set("cursor", result.nextCursor);
      const next = await apiFetch<AuditLogPage>("/api/audit-logs?" + query, { workspaceId });
      setResult((current) => ({ ...next, entries: append
        ? [...new Map([...current.entries, ...next.entries].map((entry) => [entry.id, entry])).values()] : next.entries }));
    } catch (reason) { setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"); }
    finally { setLoading(false); }
  };
  return <div className="sectionStack auditLogs">
    <div className="actionBar"><Button variant="secondary" disabled={loading} onClick={() => void load(false)}>表示を更新</Button></div>
    {error && <ErrorBanner code={error}/>}
    {!result.entries.length && <EmptyState>監査ログはまだありません。</EmptyState>}
    {result.entries.map((entry) => {
      const actor = entry.actor as { kind?: string; id?: string } | null;
      return <article className="contentPanel auditLogEntry" key={String(entry.id)}>
        <div className="auditLogHeading"><strong>{String(entry.action)}</strong><time dateTime={String(entry.occurredAt)}>{String(entry.occurredAt)}</time></div>
        <dl className="auditLogFacts">
          <div><dt>実行者</dt><dd>{actorLabels[String(actor?.kind)] ?? "不明"}: {actor?.id ?? "—"}</dd></div>
          <div><dt>対象</dt><dd>{String(entry.targetType)} / {String(entry.targetId)}</dd></div>
          <div><dt>リクエストID</dt><dd>{String(entry.requestId)}</dd></div>
        </dl>
        {entry.payloadRedactedAt ? <p className="formNote">保存期間ポリシーにより変更内容は削除済みです。</p> : <details>
          <summary>変更内容を表示</summary>
          <div className="auditLogPayload"><div><h3>変更前</h3><pre>{JSON.stringify(entry.before, null, 2)}</pre></div><div><h3>変更後</h3><pre>{JSON.stringify(entry.after, null, 2)}</pre></div></div>
        </details>}
      </article>;
    })}
    {result.nextCursor && <Button variant="secondary" disabled={loading} loading={loading} onClick={() => void load(true)}>さらに読み込む</Button>}
  </div>;
}
