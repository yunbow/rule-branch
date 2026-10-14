import type { ReactNode } from "react";
import { Badge, StatusBadge } from "../ui/index.tsx";
import { PageHeader } from "../ui/Page.tsx";
import { PublicationBadge } from "./PublicationBadge.tsx";

export function RuleDetailHeader({
  rule,
  workspaceId,
  repositories = [],
  actions,
}: {
  rule: Record<string, unknown>;
  workspaceId?: string;
  repositories?: { id: string; fullName: string }[];
  actions?: ReactNode;
}) {
  const scope = String(rule.scopeType) === "organization" ? "組織ルール" : "プロジェクトルール";

  return <>
    <PageHeader
      eyebrow={scope}
      title={String(rule.title)}
      description={<><code>{String(rule.key)}</code> の現在の状態、版履歴、関連情報を確認します。</>}
      actions={actions}
      meta={<>
        <StatusBadge kind="rules.status" value={String(rule.status)}/>
        <StatusBadge kind="layer" value={String(rule.layer)}/>
        <StatusBadge kind="enforcement" value={String(rule.enforcement)}/>
        <Badge>{String(rule.type)}</Badge>
        {typeof rule.currentVersionId === "string" && workspaceId &&
          <PublicationBadge versionId={rule.currentVersionId} workspaceId={workspaceId} repositories={repositories}/>}
      </>}
    />
    {rule.status === "stale" && Boolean(rule.staleSince) && <div className="noticeBanner warning">
      要確認状態です。開始: {String(rule.staleSince)}
    </div>}
    {rule.status === "deprecated" && <div className="noticeBanner">
      このルールは廃止済みのため、Compilerの対象外です。
    </div>}
  </>;
}
