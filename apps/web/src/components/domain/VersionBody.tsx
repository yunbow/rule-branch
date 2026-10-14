import { AiNotice, ProvenanceBadge, SYSTEM_DETECTED_NOTICE } from "./index.tsx";
import { Markdown } from "../ui/index.tsx";

export function VersionBody({
  content,
  provenance,
  automaticallyApproved = false,
}: {
  content: string;
  provenance?: Record<string, unknown> | null;
  automaticallyApproved?: boolean;
}) {
  const sourceType = typeof provenance?.sourceType === "string" ? provenance.sourceType : "human";

  return <div className="versionBody">
    <div className="inlineActions"><ProvenanceBadge sourceType={sourceType}/></div>
    {sourceType === "ai" && (
      automaticallyApproved
        ? <div className="noticeBanner">AI生成の内容です。委任されたポリシーで承認済みです。GitHubへの反映には人間のマージが必要です。</div>
        : <AiNotice/>
    )}
    {sourceType === "system" && <div className="noticeBanner">{SYSTEM_DETECTED_NOTICE}</div>}
    <Markdown>{content}</Markdown>
  </div>;
}
