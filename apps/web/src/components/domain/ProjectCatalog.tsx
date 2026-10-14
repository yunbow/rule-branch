"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, List, Search, SlidersHorizontal } from "lucide-react";
import { filterAndSortProjects, type CatalogFilter, type CatalogSort } from "../../lib/project-catalog.ts";
import type { BootstrapStatus, WorkspaceProjectSummary } from "../../lib/workspace-overview.ts";
import { ProjectCard } from "./ProjectCard.tsx";

const filters: { value: CatalogFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "action", label: "要対応" },
  { value: "setup", label: "初期設定中" },
  { value: "clear", label: "要対応なし" },
];

export function ProjectCatalog({
  workspaceId,
  projects,
  canManage,
  bootstrapStatusByProject,
}: {
  workspaceId: string;
  projects: WorkspaceProjectSummary[];
  canManage: boolean;
  bootstrapStatusByProject: Record<string, BootstrapStatus>;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [sort, setSort] = useState<CatalogSort>("priority");
  const [view, setView] = useState<"card" | "list">("card");

  const visible = useMemo(() => filterAndSortProjects({
    projects, bootstrapStatusByProject, search, filter, sort,
  }), [projects, bootstrapStatusByProject, search, filter, sort]);

  const clearFilters = () => { setSearch(""); setFilter("all"); setSort("priority"); };

  return <section className="projectCatalog" aria-label="プロジェクトを探す">
    <div className="projectCatalogToolbar">
      <label className="projectCatalogSearch">
        <span>プロジェクトを検索</span>
        <div className="projectCatalogSearchField">
          <Search size={17} aria-hidden="true"/>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="名前・スラッグ・説明で検索"
          />
        </div>
      </label>
      <label className="projectCatalogSort">
        <span><SlidersHorizontal size={14} aria-hidden="true"/> 並び順</span>
        <select value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)}>
          <option value="priority">要対応優先</option>
          <option value="name">名前順（あいうえお順）</option>
          <option value="newest">作成日の新しい順</option>
        </select>
      </label>
      <div className="projectCatalogViews" role="group" aria-label="表示形式">
        <button type="button" className={view === "card" ? "active" : ""} aria-pressed={view === "card"} aria-label="カード表示" onClick={() => setView("card")} title="カード表示"><LayoutGrid size={18}/></button>
        <button type="button" className={view === "list" ? "active" : ""} aria-pressed={view === "list"} aria-label="リスト表示" onClick={() => setView("list")} title="リスト表示"><List size={18}/></button>
      </div>
    </div>
    <div className="projectCatalogFilterBar">
      <div className="projectCatalogFilters" role="group" aria-label="プロジェクトの状態">
        {filters.map((item) =>
          <button key={item.value} type="button" className={filter === item.value ? "active" : ""} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>
            {item.label}
          </button>,
        )}
      </div>
      <p className="projectCatalogCount" role="status" aria-live="polite">
        {visible.length}件 / 全{projects.length}件
      </p>
    </div>

    {visible.length > 0
      ? <div className={`workspaceProjectGrid projectCatalogGrid${view === "list" ? " projectCatalogList" : ""}`}>
          {visible.map((project) => <ProjectCard
            key={project.id}
            workspaceId={workspaceId}
            project={project}
            canManage={canManage}
            compact={view === "list"}
            bootstrapStatus={bootstrapStatusByProject[project.id]}
          />)}
        </div>
      : <div className="projectCatalogEmpty" role="status">
          <strong>条件に一致するプロジェクトはありません</strong>
          <p>検索ワードや状態を変更して再度お試しください。</p>
          <button type="button" onClick={clearFilters}>検索条件をリセット</button>
        </div>}
  </section>;
}
