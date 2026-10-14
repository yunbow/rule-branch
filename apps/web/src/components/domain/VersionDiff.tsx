"use client";

import { hasComparison, lineDiff } from "../../lib/diff.ts";

export function VersionDiff({
  currentVersionId,
  currentContent,
  content,
  comparisonLabel = "現行版との差分",
}: {
  currentVersionId: string | null;
  currentContent?: string;
  content: string;
  comparisonLabel?: string;
}) {
  if (!hasComparison(currentVersionId)) {
    return <div className="noticeBanner">新規Versionのため、比較対象となる現行版はありません。</div>;
  }

  const lines = lineDiff(currentContent ?? "", content);
  return <div className="versionDiff" aria-label={comparisonLabel}>
    <div className="diffColumn">
      <h3>変更前</h3>
      {lines.filter((line) => line.type !== "added").map((line, index) =>
        <pre className={line.type === "removed" ? "diffRemoved" : "diffUnchanged"} key={`before-${index}`}>
          {line.type === "removed" ? "- " : "  "}{line.text}
        </pre>
      )}
    </div>
    <div className="diffColumn">
      <h3>変更後</h3>
      {lines.filter((line) => line.type !== "removed").map((line, index) =>
        <pre className={line.type === "added" ? "diffAdded" : "diffUnchanged"} key={`after-${index}`}>
          {line.type === "added" ? "+ " : "  "}{line.text}
        </pre>
      )}
    </div>
  </div>;
}
