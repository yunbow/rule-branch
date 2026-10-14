"use client";
import { RuleRow, type RuleListItem } from "./RuleRow.tsx";
import { EmptyState, Table } from "../ui/index.tsx";
export type { RuleListItem } from "./RuleRow.tsx";

export function RuleTable({
  rules, selectedRuleId, onSelect, emptyMessage = "ルールがまだありません",
}: {
  rules: RuleListItem[];
  selectedRuleId?: string;
  onSelect?: (rule: RuleListItem) => void;
  emptyMessage?: string;
}) {
  if (!rules.length) return <EmptyState>{emptyMessage}</EmptyState>;
  return <Table><thead><tr>
    <th>ルール</th><th>分類</th><th>適用レベル</th><th>状態</th>
    <th>反映状況</th><th>更新日</th><th>操作</th>
  </tr></thead><tbody>
    {rules.map((rule) => <RuleRow key={rule.id} rule={rule}
      selected={selectedRuleId === rule.id} onSelect={onSelect}/>)}
  </tbody></Table>;
}
