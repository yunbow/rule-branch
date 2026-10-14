"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { InjectionWarningBadge } from "./InjectionWarningBadge.tsx";
import { PublicationBadge, type PublicationState } from "./PublicationBadge.tsx";
import { Badge, StatusBadge } from "../ui/index.tsx";
import { getStatusLabel } from "../../lib/labels.ts";

export type RuleListItem = {
  id: string; title: string; key: string; layer: string; enforcement: string;
  status: string; type: string; scopeType: string; sourceType?: string;
  currentVersionId?: string | null; updatedAt?: string | null;
  possiblePromptInjection?: boolean; publicationState?: PublicationState;
};
const label = (kind: string, value: string) => getStatusLabel(kind, value).label;

export function RuleRow({
  rule, selected, onSelect,
}: {
  rule: RuleListItem;
  selected?: boolean;
  onSelect?: (rule: RuleListItem) => void;
}) {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId?: string }>();
  const href = projectId && rule.scopeType !== "organization"
    ? `/w/${workspaceId}/projects/${projectId}/rules/${rule.id}`
    : `/w/${workspaceId}/rules/${rule.id}`;

  return <tr aria-selected={Boolean(selected)}>
    <td className="ruleTitleCell">
      <Link className="ruleTitleLink" href={href}>{rule.title}</Link>
      <small>{rule.key}</small>
      {rule.possiblePromptInjection && <div><InjectionWarningBadge/> <small>抽出時に注意事項あり</small></div>}
    </td>
    <td><Badge tone="blue">{label("layer", rule.layer)}</Badge> <span className="ruleType">{rule.type}</span></td>
    <td><Badge>{label("enforcement", rule.enforcement)}</Badge></td>
    <td><StatusBadge kind="rules.status" value={rule.status}/></td>
    <td>
      {rule.currentVersionId && workspaceId
        ? <PublicationBadge versionId={rule.currentVersionId} workspaceId={workspaceId} initialState={rule.publicationState}/>
        : <span className="ruleMetaMuted">未設定</span>}
    </td>
    <td>{rule.updatedAt ? new Date(rule.updatedAt).toLocaleDateString("ja-JP") : "—"}</td>
    <td className="ruleActionsCell">
      {onSelect
        ? <button type="button" className="ruleTableAction" aria-pressed={Boolean(selected)} onClick={() => onSelect(rule)}>候補をレビュー</button>
        : <Link className="ruleTableAction" href={href}>詳細を見る</Link>}
    </td>
  </tr>;
}
