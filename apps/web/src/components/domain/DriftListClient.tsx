"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { filterFindings, matchesFindingPath } from "../../lib/drift-filter.ts";
import { presentDriftFindings, countDriftStatus, type DriftSort } from "../../lib/drift-presentation.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { driftActionPermissions } from "../../lib/drift-list.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../shared/permissions.ts";
import { Button, EmptyState } from "../ui/index.tsx";
import { PageSection } from "../ui/Page.tsx";
import { FindingRow, type FindingView } from "./FindingRow.tsx";
import { JobProgress, type JobView } from "./JobProgress.tsx";
import { StaleRuleRow } from "./StaleRuleRow.tsx";

export type DriftRule = { id: string; title: string; projectId?: string | null; status: string; staleSince?: string | null };

const STATUS_LABELS: Record<string, string> = {
  open: "未処理", accepted: "対応中", resolved: "解決",
  dismissed: "見送り", expired: "期限切れ",
};
const DEFAULT_STATUSES = ["open", "accepted"];
const SEVERITIES = [
  { value: "", label: "すべての重要度" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "情報" },
];
const SORT_OPTIONS: { value: DriftSort; label: string }[] = [
  { value: "priority", label: "重要度が高い順" },
  { value: "recent", label: "検出が新しい順" },
  { value: "confidence", label: "確信度が高い順" },
];

export function DriftListClient({
  workspaceId, projectId, workspaceKind, role, rules, findings, repositories,
  initialType = "", initialPath = "", initialTab = "stale", initialStatus,
  initialSearch = "", initialSeverity = "", initialRepositoryId = "", initialSort = "priority",
  initialJobs = [],
}: {
  workspaceId: string;
  projectId: string;
  workspaceKind: WorkspaceKind;
  role: WorkspaceRole;
  rules: DriftRule[];
  findings: FindingView[];
  repositories: { id: string; fullName: string }[];
  initialType?: string;
  initialPath?: string;
  initialTab?: "stale" | "findings";
  initialStatus?: string;
  initialSearch?: string;
  initialSeverity?: string;
  initialRepositoryId?: string;
  initialSort?: DriftSort;
  initialJobs?: JobView[];
}) {
  const [tab, setTab] = useState<"stale" | "findings">(initialTab);
  const [statuses, setStatuses] = useState<string[]>(() => {
    if (initialStatus === "none") return [];
    const values = (initialStatus ?? "").split(",").filter((value) =>
      Object.prototype.hasOwnProperty.call(STATUS_LABELS, value));
    return values.length ? Array.from(new Set(values)) : DEFAULT_STATUSES;
  });
  const [type, setType] = useState(initialType);
  const [path, setPath] = useState(initialPath);
  const [search, setSearch] = useState(initialSearch);
  const [severity, setSeverity] = useState(initialSeverity);
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId);
  const [sort, setSort] = useState<DriftSort>(initialSort);
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  const permissions = driftActionPermissions(workspaceKind, role);
  const titles = useMemo(() =>
    Object.fromEntries(rules.map((rule) => [rule.id, rule.title])) as Record<string, string>,
    [rules]);
  const stale = rules.filter((rule) => rule.status === "stale");
  const totals = countDriftStatus(findings);
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const activeFilters = Boolean(search.trim() || severity || repositoryId || type || path ||
    sort !== "priority" ||
    statuses.length !== DEFAULT_STATUSES.length ||
    !DEFAULT_STATUSES.every((status) => statuses.includes(status)));

  const { visible: scopedFindings, pathMatched } =
    filterFindings(findings, statuses, type, path);
  const displayedFindings = presentDriftFindings(
    scopedFindings, { search, severity, repositoryId, sort }, titles);
  const scopedStaleFindings = presentDriftFindings(
    findings, { search, severity, repositoryId, sort }, titles);
  const staleFiltersApplied = Boolean(search.trim() || severity || repositoryId);
  const searchOnly = Boolean(search.trim()) && !severity && !repositoryId;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredStale = stale.filter((rule) =>
    !staleFiltersApplied ||
    scopedStaleFindings.some((finding) => finding.ruleId === rule.id) ||
    (searchOnly && rule.title.toLocaleLowerCase().includes(normalizedSearch)));

  // The first visible finding of a rule follows the user's selected sort mode.
  const firstIndex = new Map<string, number>();
  scopedStaleFindings
    .filter((finding) => finding.status === "open" || finding.status === "accepted")
    .forEach((finding, index) => {
      if (finding.ruleId && !firstIndex.has(finding.ruleId))
        firstIndex.set(finding.ruleId, index);
    });
  filteredStale.sort((a, b) => {
    const aIndex = firstIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = firstIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex || String(b.staleSince ?? "").localeCompare(String(a.staleSince ?? "")) ||
      a.title.localeCompare(b.title, "ja");
  });

  const onJobDone = useCallback((completed: JobView) => {
    setJobs((current) => current.map((job) => job.id === completed.id ? completed : job));
  }, []);

  useEffect(() => {
    // Keep existing publication verification links (tab, type, path, status)
    // intact while allowing the new view controls to be shared/bookmarked.
    const url = new URL(window.location.href);
    for (const key of ["tab", "type", "path", "status", "q", "severity", "repo", "sort"])
      url.searchParams.delete(key);
    if (tab === "findings") url.searchParams.set("tab", tab);
    if (type) url.searchParams.set("type", type);
    if (path) url.searchParams.set("path", path);
    const selected = Object.keys(STATUS_LABELS).filter((value) => statuses.includes(value));
    if (!(selected.length === 2 && DEFAULT_STATUSES.every((item) => selected.includes(item))))
      url.searchParams.set("status", selected.join(",") || "none");
    if (search.trim()) url.searchParams.set("q", search.trim());
    if (severity) url.searchParams.set("severity", severity);
    if (repositoryId) url.searchParams.set("repo", repositoryId);
    if (sort !== "priority") url.searchParams.set("sort", sort);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [tab, statuses, type, path, search, severity, repositoryId, sort]);

  const trigger = async () => {
    setTriggering(true);
    setError(null);
    try {
      const result = await apiFetch<{ jobId: string; jobIds?: string[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/drift-triggers`,
        { method: "POST", workspaceId, body: {} },
      );
      const ids = result.jobIds?.length ? result.jobIds : [result.jobId];
      setJobs(ids.map((id) => ({ id, type: "drift_scan", status: "queued", attempts: 0 })));
    } catch (cause) {
      setError(getErrorMessage(cause instanceof ApiError ? cause.code : "INTERNAL_ERROR"));
    } finally {
      setTriggering(false);
    }
  };

  const resetFilters = () => {
    setSearch(""); setSeverity(""); setRepositoryId("");
    setStatuses(DEFAULT_STATUSES);
    setType(""); setPath(""); setSort("priority");
  };
  const changeTab = (next: "stale" | "findings") => {
    setTab(next);
    if (next === "stale") { setType(""); setPath(""); }
  };
  const showSummary = (next: "stale" | "findings", onlyStatus?: string) => {
    setTab(next);
    setSearch(""); setSeverity(""); setRepositoryId("");
    setType(""); setPath(""); setSort("priority");
    setStatuses(onlyStatus ? [onlyStatus] : DEFAULT_STATUSES);
  };

  return <div className="driftWorkspace">
    <section className="driftSummarySection" aria-label="Driftの状況">
      <div className="driftSummaryCards">
        <button type="button" className="driftSummaryCard"
          aria-pressed={tab === "stale"} onClick={() => showSummary("stale")}>
          <span>要確認ルール</span><strong>{stale.length}</strong><small>件</small>
        </button>
        <button type="button" className="driftSummaryCard"
          aria-pressed={tab === "findings" && statuses.length === 1 && statuses[0] === "open"}
          onClick={() => showSummary("findings", "open")}>
          <span>未処理の指摘</span><strong>{totals.open}</strong><small>件</small>
        </button>
        <button type="button" className="driftSummaryCard"
          aria-pressed={tab === "findings" && statuses.length === 1 && statuses[0] === "accepted"}
          onClick={() => showSummary("findings", "accepted")}>
          <span>対応中</span><strong>{totals.accepted}</strong><small>件</small>
        </button>
      </div>
      {permissions.manualTrigger && <div className="driftScanAction">
        <Button type="button" variant="secondary" loading={triggering}
          disabled={!repositories.length || triggering || activeJobs.length > 0}
          onClick={() => void trigger()}>
          <RefreshCw size={16} aria-hidden="true"/>ずれを再スキャン
        </Button>
        {!repositories.length && <small>有効なリポジトリがありません</small>}
      </div>}
    </section>

    {jobs.length > 0 && <div className="driftScanJobs" aria-label="再スキャンの処理状況">
      {jobs.map((job) => <JobProgress key={job.id} job={job} workspaceId={workspaceId}
        compact onDone={onJobDone}/>)}
    </div>}
    {error && <p className="formError" role="alert">{error}</p>}

    <div className="driftViewTabs" role="group" aria-label="Drift表示">
      <button type="button" className={tab === "stale" ? "active" : ""}
        aria-pressed={tab === "stale"} onClick={() => changeTab("stale")}>
        要確認ルール <span>{stale.length}</span>
      </button>
      <button type="button" className={tab === "findings" ? "active" : ""}
        aria-pressed={tab === "findings"} onClick={() => changeTab("findings")}>
        指摘一覧 <span>{findings.length}</span>
      </button>
    </div>

    <section className="driftFilterPanel" aria-label="表示条件">
      <label className="driftSearchField">
        <span>ルール・指摘を検索</span>
        <div className="driftSearchInput">
          <Search size={16} aria-hidden="true"/>
          <input type="search" maxLength={100} placeholder="ルール名、指摘、対象パス"
            value={search} onChange={(event) => setSearch(event.target.value)}/>
        </div>
      </label>
      <label className="driftFilterField">
        <span>重要度</span>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
          {SEVERITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="driftFilterField">
        <span>リポジトリ</span>
        <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">すべて</option>
          {repositories.map((repository) =>
            <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}
        </select>
      </label>
      <label className="driftFilterField">
        <span>並び替え</span>
        <select value={sort} onChange={(event) => setSort(event.target.value as DriftSort)}>
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {activeFilters && <button type="button" className="driftResetFilters"
        onClick={resetFilters}>条件をクリア</button>}
    </section>

    {tab === "stale"
      ? <PageSection title="要確認ルール" description="ルールを展開すると関連する指摘・根拠と対応操作を確認できます。"
          className="driftResultsSection">
          <p className="driftResultsCount" role="status">{filteredStale.length}件 / 全{stale.length}件</p>
          {filteredStale.length
            ? <div className="driftRuleList">{filteredStale.map((rule) =>
                <StaleRuleRow key={rule.id} rule={rule}
                  findings={findings.filter((finding) => finding.ruleId === rule.id)}
                  visibleFindings={scopedStaleFindings.filter((finding) => finding.ruleId === rule.id)}
                  workspaceId={workspaceId} projectId={projectId}
                  workspaceKind={workspaceKind} role={role} repositories={repositories}/>)}</div>
            : <EmptyState>{staleFiltersApplied
                ? "条件に一致する要確認ルールはありません。検索や絞り込みを変更してください。"
                : "要確認として登録されたルールはありません。未解析の場合は再スキャンしてください。"}</EmptyState>}
        </PageSection>
      : <PageSection title="検出された指摘" description="重要度と根拠を確認し、対応対象の指摘を選択します。"
          className="driftResultsSection">
          {(type || path) && <div className="driftFilterContext">
            <strong>反映検証からの絞り込み</strong>
            <p>{type === "artifact_mismatch" ? "生成ファイルの不一致" : type}{path && <>：<code>{path}</code></>}</p>
            {path && !pathMatched && <p>このパスと完全一致する指摘は記録上確認できません。該当する種類の指摘を表示しています。</p>}
            <button type="button" onClick={() => { setType(""); setPath(""); }}>絞り込みを解除</button>
          </div>}
          <div className="driftStatusChips" role="group" aria-label="指摘の状態で絞り込み">
            {Object.entries(STATUS_LABELS).map(([value, label]) =>
              <label key={value} className={statuses.includes(value) ? "active" : ""}>
                <input type="checkbox" checked={statuses.includes(value)}
                  onChange={(event) => setStatuses((current) => event.target.checked
                    ? [...current, value] : current.filter((item) => item !== value))}/>
                {label} <small>{findings.filter((finding) => finding.status === value).length}</small>
              </label>)}
          </div>
          <p className="driftResultsCount" role="status">表示：{displayedFindings.length}件 / 全{findings.length}件</p>
          {displayedFindings.length
            ? <div className="driftFindingList">{displayedFindings.map((finding) =>
                <FindingRow key={finding.id} finding={finding}
                  ruleTitle={titles[finding.ruleId ?? ""] ?? "ルール未特定"}
                  initialExpanded={Boolean(path && pathMatched && matchesFindingPath(finding, path))}
                  workspaceId={workspaceId} projectId={projectId}
                  workspaceKind={workspaceKind} role={role} repositories={repositories}/>)}</div>
            : <EmptyState>{findings.length
                ? "条件に一致する指摘はありません。状態や検索条件を変更してください。"
                : "検出された指摘はありません。未解析の場合は再スキャンしてください。"}</EmptyState>}
        </PageSection>}
  </div>;
}

export default DriftListClient;
