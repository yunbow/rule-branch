"use client";

import { useState } from "react";

const VISIBLE_TAGS = 4;

export function ProjectHeaderTags({ tags }: { tags: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  if (!uniqueTags.length) return null;

  const remaining = Math.max(0, uniqueTags.length - VISIBLE_TAGS);
  return <div className="projectHeaderTags" aria-label="プロジェクトの技術・テーマ">
    {uniqueTags.slice(0, expanded ? undefined : VISIBLE_TAGS).map((tag) =>
      <span className="projectMetaChip" key={tag}>{tag}</span>)}
    {remaining > 0 && <button type="button" className="projectMetaMore"
      aria-expanded={expanded}
      aria-label={expanded ? "技術・テーマタグを折りたたむ" : "技術・テーマタグを" + remaining + "件展開"}
      onClick={() => setExpanded((current) => !current)}>
      {expanded ? "閉じる" : "＋" + remaining + "件"}
    </button>}
  </div>;
}
