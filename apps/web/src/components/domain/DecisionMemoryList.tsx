"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ClipboardCheck, Clock3, GitBranch, Search } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import {
  countDecisionMemories, DECISION_PAGE_SIZE, filterAndSortDecisionMemories,
  filterDecisionMemoriesForProject, groupDecisionMemories,
  type DecisionPeriod, type DecisionSort, type DecisionView,
} from "../../lib/decision-memory.ts";
import { Spinner } from "../ui/index.tsx";
import { PageSection } from "../ui/Page.tsx";
import { DecisionMemoryCard, type DecisionMemoryView, type DecisionRuleLink } from "./DecisionMemoryCard.tsx";

type ApiMemory = Record<string, unknown>;
type ApiRule = { id: unknown; projectId?: unknown; title?: unknown };
type Loaded = { memories: DecisionMemoryView[]; rulesById: Record<string, DecisionRuleLink> };

const PERIOD_OPTIONS: Array<{ value: DecisionPeriod; label: string }> = [
  { value: "all", label: "すべての期間" },
  { value: "7", label: "直近7日" },
  { value: "30", label: "直近30日" },
  { value: "90", label: "直近90日" },
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toMemory(value: ApiMemory): DecisionMemoryView {
  return {
    id: asString(value.id),
    title: asString(value.title),
    context: asString(value.context),
    decision: asString(value.decision),
    consequences: asString(value.consequences),
    projectId: typeof value.projectId === "string" ? value.projectId : null,
    deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : null,
    linkedRuleIds: Array.isArray(value.linkedRuleIds)
      ? value.linkedRuleIds.filter((id): id is string => typeof id === "string") : [],
    linkedEvidenceIds: Array.isArray(value.linkedEvidenceIds)
      ? value.linkedEvidenceIds.filter((id): id is string => typeof id === "string") : [],
    createdAt: asString(value.createdAt),
    approvedRuleVersionId: typeof value.approvedRuleVersionId === "string"
      ? value.approvedRuleVersionId : null,
    approvedRuleVersionNumber: typeof value.approvedRuleVersionNumber === "number" &&
      Number.isFinite(value.approvedRuleVersionNumber) ? value.approvedRuleVersionNumber : null,
    approvedChangeType: typeof value.approvedChangeType === "string" ? value.approvedChangeType : null,
    approvalComment: typeof value.approvalComment === "string" ? value.approvalComment : null,
    approvalMode: value.approvalMode === "human" || value.approvalMode === "automatic"
      ? value.approvalMode : null,
  };
}

export function DecisionMemoryList({
  workspaceId, projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [ruleFilter, setRuleFilter] = useState("");
  const [period, setPeriod] = useState<DecisionPeriod>("all");
  const [sort, setSort] = useState<DecisionSort>("newest");
  const [view, setView] = useState<DecisionView>("timeline");
  const [visibleLimit, setVisibleLimit] = useState(DECISION_PAGE_SIZE);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([
      apiFetch<{ decisionMemories: ApiMemory[] }>("/api/decision-memories", { workspaceId }),
      apiFetch<{ rules: ApiRule[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/rules`, { workspaceId }),
    ]).then(([memoryResult, ruleResult]) => {
      if (!active) return;
      const rules = ruleResult.rules.map((rule) => ({
        id: String(rule.id),
        projectId: typeof rule.projectId === "string" ? rule.projectId : null,
      }));
      const rulesById: Record<string, DecisionRuleLink> = {};
      for (const rule of ruleResult.rules) {
        if (rule.projectId !== projectId) continue;
        const id = String(rule.id);
        rulesById[id] = {
          title: typeof rule.title === "string" ? rule.title : id,
          href: `/w/${workspaceId}/projects/${projectId}/rules/${encodeURIComponent(id)}`,
        };
      }
      setLoaded({
        memories: filterDecisionMemoriesForProject(
          memoryResult.decisionMemories.map(toMemory), rules, projectId),
        rulesById,
      });
    }).catch((reason: unknown) => {
      if (active) setError(getErrorMessage(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR"));
    });
    return () => { active = false; };
  }, [workspaceId, projectId, retry]);

  const memories = loaded?.memories ?? [];
  const rulesById = loaded?.rulesById ?? {};
  const ruleTitles = Object.fromEntries(Object.entries(rulesById)
    .map(([id, rule]) => [id, rule.title]));
  const stats = countDecisionMemories(memories, Date.now());
  const ruleOptions = [...new Set(memories.flatMap((memory) => memory.linkedRuleIds))]
    .sort((a, b) => (rulesById[a]?.title ?? a).localeCompare(rulesById[b]?.title ?? b, "ja"));
  const visible = filterAndSortDecisionMemories(memories, {
    query, ruleId: ruleFilter, period, sort, now: Date.now(), ruleTitles,
  });
  const shown = visible.slice(0, visibleLimit);
  const groups = groupDecisionMemories(shown, ruleTitles);
  const hasFilters = Boolean(query.trim() || ruleFilter || period !== "all" || sort !== "newest");

  const resetPagination = () => setVisibleLimit(DECISION_PAGE_SIZE);
  const clearFilters = () => {
    setQuery(""); setRuleFilter(""); setPeriod("all"); setSort("newest"); resetPagination();
  };

  if (!loaded && !error) return <div className="decisionMemoryLoading" role="status">
    <Spinner ariaLabel="判断記録を読み込み中"/>判断記録を読み込み中です…
  </div>;
  if (!loaded && error) return <div className="decisionMemoryFailure" role="alert">
    <p>{error}</p>
    <button type="button" onClick={() => setRetry((current) => current + 1)}>再読み込み</button>
  </div>;

  return <div className="decisionMemoryWorkspace">
    <section className="decisionMemoryStats" aria-label="判断記録の概要">
      {[
        { label: "判断記録", value: stats.total, Icon: ClipboardCheck },
        { label: "直近30日", value: stats.recent30Days, Icon: Clock3 },
        { label: "関連ルール", value: stats.relatedRules, Icon: GitBranch },
      ].map(({ label, value, Icon }) =>
        <div className="decisionMemoryStat" key={label}>
          <span><Icon size={17} aria-hidden="true"/>{label}</span>
          <strong>{value}<small>件</small></strong>
        </div>)}
    </section>

    {error && <div className="decisionMemoryFailure" role="alert">
      <p>{error}。前回取得した記録を表示しています。</p>
      <button type="button" onClick={() => setRetry((current) => current + 1)}>再読み込み</button>
    </div>}

    {memories.length === 0
      ? <div className="decisionMemoryEmpty">
          <p>このプロジェクトには判断記録がありません。ルールを承認・更新すると、その判断理由と関連情報が記録されます。</p>
          <Link href={`/w/${workspaceId}/reviews?project=${encodeURIComponent(projectId)}`}>
            承認待ちを確認 →
          </Link>
        </div>
      : <>
        <div className="decisionMemoryViews" role="group" aria-label="判断記録の表示方法">
          <button type="button" className={view === "timeline" ? "active" : ""}
            aria-pressed={view === "timeline"}
            onClick={() => { setView("timeline"); resetPagination(); }}>新しい順に見る</button>
          <button type="button" className={view === "rule" ? "active" : ""}
            aria-pressed={view === "rule"}
            onClick={() => { setView("rule"); resetPagination(); }}>ルール別にまとめる</button>
        </div>
        <section className="decisionMemoryFilters" aria-label="判断記録の表示条件">
          <label className="decisionMemorySearch">
            <span>記録を検索</span>
            <span className="decisionMemorySearchInput">
              <Search size={16} aria-hidden="true"/>
              <input type="search" maxLength={150} value={query}
                placeholder="ルール名・背景・判断内容"
                onChange={(event) => { setQuery(event.target.value); resetPagination(); }}/>
            </span>
          </label>
          <label>
            <span>関連ルール</span>
            <select value={ruleFilter} onChange={(event) => {
              setRuleFilter(event.target.value); resetPagination();
            }}>
              <option value="">すべてのルール</option>
              {ruleOptions.map((id) => <option value={id} key={id}>
                {rulesById[id]?.title ?? `過去のルール（${id.slice(0, 8)}…）`}
              </option>)}
            </select>
          </label>
          <label>
            <span>期間</span>
            <select value={period} onChange={(event) => {
              setPeriod(event.target.value as DecisionPeriod); resetPagination();
            }}>
              {PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>
                {option.label}
              </option>)}
            </select>
          </label>
          <label>
            <span>並び替え</span>
            <select value={sort} onChange={(event) => {
              setSort(event.target.value as DecisionSort); resetPagination();
            }}>
              <option value="newest">新しい順</option>
              <option value="oldest">古い順</option>
            </select>
          </label>
        </section>
        <PageSection
          title="判断の履歴"
          description="判断内容と背景を確認し、承認版やGitHub反映状況へ移動できます。"
          className="decisionHistorySection"
        >
          <div className="decisionMemoryListStatus">
            <span role="status">表示 {shown.length}件 / 条件一致 {visible.length}件（全{memories.length}件）</span>
            {hasFilters && <button type="button" onClick={clearFilters}>条件をクリア</button>}
          </div>
          {shown.length === 0
            ? <div className="decisionMemoryEmpty">
                <p>条件に一致する判断記録はありません。</p>
                <button type="button" onClick={clearFilters}>絞り込みを解除</button>
              </div>
            : view === "timeline"
              ? <div className="decisionMemoryCards">
                  {shown.map((memory) =>
                    <DecisionMemoryCard key={memory.id} memory={memory} rulesById={rulesById}
                      workspaceId={workspaceId} projectId={projectId}/>)}
                </div>
              : <div className="decisionMemoryGroups">
                  {groups.map((group) => <section className="decisionMemoryGroup" key={group.ruleId || "__unlinked__"}>
                    <header>
                      <h3>{group.title}</h3>
                      <span>{group.memories.length}件</span>
                    </header>
                    <div className="decisionMemoryCards">
                      {group.memories.map((memory) =>
                        <DecisionMemoryCard key={memory.id} memory={memory} rulesById={rulesById}
                          workspaceId={workspaceId} projectId={projectId}/>)}
                    </div>
                  </section>)}
                </div>}
          {visible.length > DECISION_PAGE_SIZE && <div className="decisionMemoryPagination">
            <span>{shown.length} / {visible.length}件</span>
            {shown.length < visible.length
              ? <button type="button" onClick={() =>
                  setVisibleLimit((current) => current + DECISION_PAGE_SIZE)}>
                  さらに{Math.min(DECISION_PAGE_SIZE, visible.length - shown.length)}件を表示
                </button>
              : <button type="button" onClick={() => setVisibleLimit(DECISION_PAGE_SIZE)}>
                  最初の10件に戻す
                </button>}
          </div>}
        </PageSection>
      </>}
  </div>;
}
