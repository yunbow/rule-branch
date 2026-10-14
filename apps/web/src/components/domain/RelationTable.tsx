"use client";

import { useState } from "react";
import { EmptyState, StatusBadge, Table } from "../ui/index.tsx";

export type RelationListItem = {
  id: string;
  childRuleId: string;
  parentRuleId: string;
  relationType: string;
  rationale?: string | null;
  validationStatus: string;
  createdAt?: string | null;
};

const excerpt = (value: string) => value.length > 80 ? `${value.slice(0, 80)}…` : value;

export function RelationTable({
  relations,
  ruleTitles,
}: {
  relations: RelationListItem[];
  ruleTitles: Record<string, string>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!relations.length) return <EmptyState>ルール関係はまだ作成されていません。</EmptyState>;

  return <Table>
    <thead><tr>
      <th>子ルール</th><th>親ルール</th><th>関係</th><th>理由</th><th>検証状態</th><th>作成日</th>
    </tr></thead>
    <tbody>{relations.map((relation) =>
      <tr key={relation.id} onClick={() => setSelectedId(relation.id)} style={{ cursor: "pointer" }}>
        <td>{ruleTitles[relation.childRuleId] ?? relation.childRuleId}</td>
        <td>{ruleTitles[relation.parentRuleId] ?? relation.parentRuleId}</td>
        <td><StatusBadge kind="relationType" value={relation.relationType}/></td>
        <td>{relation.rationale
          ? <details className="popover" open={selectedId === relation.id}>
              <summary onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedId((current) => current === relation.id ? null : relation.id);
              }}>
                {selectedId === relation.id ? "詳細を閉じる" : excerpt(relation.rationale)}
              </summary>
              <p>{relation.rationale}</p>
            </details>
          : "—"}</td>
        <td><StatusBadge kind="rule_relations.validationStatus" value={relation.validationStatus}/></td>
        <td>{relation.createdAt ? new Date(relation.createdAt).toLocaleDateString("ja-JP") : "—"}</td>
      </tr>
    )}</tbody>
  </Table>;
}
