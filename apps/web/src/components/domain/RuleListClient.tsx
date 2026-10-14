"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CandidateReviewPanel } from "./CandidateReviewPanel.tsx";
import { RuleTable, type RuleListItem } from "./RuleTable.tsx";
import { Button, Select, TextField } from "../ui/index.tsx";
import { hasWorkspacePermission, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { filterRules, type RuleFilters, type RuleTab } from "../../lib/rule-list.ts";

export type { RuleTab } from "../../lib/rule-list.ts";

const tabs: { id: RuleTab; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "draft", label: "候補" },
  { id: "stale", label: "要確認" },
  { id: "active", label: "有効" },
  { id: "other", label: "その他" },
];

export function RuleListClient({
  rules,
  workspaceId,
  projectId,
  workspaceKind,
  role,
  initialTab = "all",
  initialFilters,
  scopeType,
}: {
  rules: RuleListItem[];
  workspaceId: string;
  projectId?: string;
  workspaceKind: WorkspaceKind;
  role: WorkspaceRole;
  initialTab?: RuleTab;
  initialFilters?: RuleFilters;
  scopeType?: string;
}) {
  const [tab, setTab] = useState<RuleTab>(initialTab);
  const [filters, setFilters] = useState<RuleFilters>(initialFilters ?? { layer: "", enforcement: "", type: "", query: "" });
  const [selected, setSelected] = useState<RuleListItem | null>(null);

  const scopedRules = scopeType ? rules.filter((rule) => rule.scopeType === scopeType) : rules;
  const visible = filterRules(scopedRules, tab, filters);
  const counts = Object.fromEntries(tabs.map((item) => [
    item.id,
    filterRules(scopedRules, item.id, { layer: "", enforcement: "", type: "", query: "" }).length,
  ])) as Record<RuleTab, number>;
  useEffect(() => {
    // Update the URL without rerunning the entire server query for each keystroke.
    const url = new URL(window.location.href);
    for (const key of ["tab", "q", "layer", "enforcement", "type"]) url.searchParams.delete(key);
    if (tab !== "all") url.searchParams.set("tab", tab);
    if (filters.query) url.searchParams.set("q", filters.query);
    if (filters.layer) url.searchParams.set("layer", filters.layer);
    if (filters.enforcement) url.searchParams.set("enforcement", filters.enforcement);
    if (filters.type) url.searchParams.set("type", filters.type);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [tab, filters]);
  const writable = hasWorkspacePermission(workspaceKind, role, "member");
  const chooseTab = (next: RuleTab) => {
    setTab(next);
    if (next !== "draft") setSelected(null);
  };
  const select = tab === "draft" ? setSelected : undefined;

  return (
    <>
      <div className="ruleListToolbar">
        <div className="segmentedTabs" role="tablist" aria-label="ルールの状態">
          {tabs.map((item) => (
            <Button
              type="button"
              variant="ghost"
              className={tab === item.id ? "active" : ""}
              aria-selected={tab === item.id}
              key={item.id}
              onClick={() => chooseTab(item.id)}
            >
              {item.label} <span className="ruleTabCount">{counts[item.id]}</span>
            </Button>
          ))}
        </div>
        {writable && (
          <Link className="button primary" href={projectId ? `/w/${workspaceId}/projects/${projectId}/rules/new` : `/w/${workspaceId}/rules/new`}>
            ルールを作成
          </Link>
        )}
      </div>

      <div className="filterPanel" aria-label="ルールの絞り込み">
        <Select label="レイヤー" value={filters.layer} onChange={(event) => setFilters({ ...filters, layer: event.target.value })}>
          <option value="">すべて</option>
          <option value="L1">L1</option>
          <option value="L2">L2</option>
          <option value="L3">L3</option>
        </Select>
        <Select label="適用レベル" value={filters.enforcement} onChange={(event) => setFilters({ ...filters, enforcement: event.target.value })}>
          <option value="">すべて</option>
          <option value="locked">必須（組織）</option>
          <option value="default">標準</option>
          <option value="advisory">推奨</option>
          <option value="personal">個人設定</option>
        </Select>
        <Select label="種別" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
          <option value="">すべて</option>
          <option value="policy">policy</option>
          <option value="guideline">guideline</option>
          <option value="workflow">workflow</option>
          <option value="architecture">architecture</option>
          <option value="security">security</option>
          <option value="coding-style">coding-style</option>
          <option value="interaction">interaction</option>
        </Select>
        <TextField label="検索" placeholder="タイトル・キーで検索" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
      </div>

      <div className="ruleResultsToolbar">
        <span>{visible.length}件 / 全{scopedRules.length}件</span>
        {(filters.query || filters.layer || filters.enforcement || filters.type) &&
          <button type="button" onClick={() => setFilters({ layer: "", enforcement: "", type: "", query: "" })}>
            絞り込みを解除
          </button>}
      </div>
      <div className={selected && tab === "draft" ? "ruleReviewLayout" : ""}>
        <div className="ruleReviewTable">
          <RuleTable rules={visible} selectedRuleId={selected?.id} onSelect={select}
            emptyMessage={scopedRules.length ? "条件に一致するルールはありません。絞り込みを変更してください。" : "登録されたルールはまだありません。"} />
        </div>
        {selected && tab === "draft" && <div className="ruleReviewPanel">
          <div className="ruleReviewPanelHeader">
            <strong>{selected.title} の候補</strong>
            <button type="button" onClick={() => setSelected(null)}>閉じる</button>
          </div>
          <CandidateReviewPanel rule={selected} workspaceId={workspaceId}
            workspaceKind={workspaceKind} role={role} onDone={() => setSelected(null)}/>
        </div>}
      </div>
    </>
  );
}
