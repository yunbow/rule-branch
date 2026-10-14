import Link from "next/link";
import { EmptyState, StatusBadge, Table } from "../ui/index.tsx";

const CHANGE_LABELS: Record<string, string> = {
  initial: "新規",
  clarify: "明確化",
  tighten: "強化",
  relax: "緩和",
  refactor: "整理",
  deprecate: "廃止",
};
const SOURCE_LABELS: Record<string, string> = {
  human: "人間",
  ai: "AI",
  system: "システム",
  import: "インポート",
};

export function VersionHistoryTable({
  versions,
  basePath,
}: {
  versions: Record<string, unknown>[];
  basePath: string;
}) {
  return <Table empty={!versions.length ? <EmptyState>まだVersionがありません。</EmptyState> : undefined}>
    <thead><tr><th>Version</th><th>状態</th><th>変更種別</th><th>作成元</th><th>作成日</th><th>承認者</th></tr></thead>
    <tbody>{versions.map((version) => {
      const source = String((version.provenance as Record<string, unknown> | undefined)?.sourceType ?? "human");
      return <tr key={String(version.id)}>
        <td><Link href={`${basePath}/versions/${version.id}`}>v{String(version.version)}</Link></td>
        <td><StatusBadge kind="rule_versions.status" value={String(version.status)}/></td>
        <td>{CHANGE_LABELS[String(version.changeType)] ?? String(version.changeType)}</td>
        <td>{SOURCE_LABELS[source] ?? source}</td>
        <td>{String(version.createdAt ?? "—")}</td>
        <td>{String(version.approvedBy ?? "—")}</td>
      </tr>;
    })}</tbody>
  </Table>;
}
