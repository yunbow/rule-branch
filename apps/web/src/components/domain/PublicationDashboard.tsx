"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, GitPullRequest, RefreshCw, Search } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { isAbortError, LatestRequest } from "../../lib/latest-request.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import {
  formatPublicationDate, getPublicationSummary, getRepositoryPublication,
  matchesPublicationFilter, normalizePublicationData, publicationAttentionRank,
  safePublicationPrUrl,
  type PublicationData, type PublicationFilter, type PublicationRepository, type PublicationSort,
} from "../../lib/publication-overview.ts";
import { canRecompile, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { RepositoryPublicationCard } from "./RepositoryPublicationCard.tsx";

type Item = { repository: PublicationRepository; publication: ReturnType<typeof getRepositoryPublication> };

const FILTERS: { value: PublicationFilter; label: string }[] = [
  { value: "all", label: "すべての状態" },
  { value: "draft", label: "Draft PR" },
  { value: "pending", label: "検証待ち・記録なし" },
  { value: "mismatch", label: "不一致" },
  { value: "verified", label: "検証済み" },
  { value: "unrecorded", label: "反映記録なし" },
];
const SORTS: { value: PublicationSort; label: string }[] = [
  { value: "attention", label: "要対応順" },
  { value: "recent", label: "更新が新しい順" },
  { value: "name", label: "リポジトリ名順" },
];

export function PublicationDashboard({
  repositories, initialData, initialFetchedAt, workspaceId, projectId, kind, role,
}: {
  repositories: PublicationRepository[];
  initialData: PublicationData;
  initialFetchedAt: string;
  workspaceId: string;
  projectId: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
}) {
  const [data, setData] = useState(initialData);
  const [lastFetchedAt, setLastFetchedAt] = useState(initialFetchedAt);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PublicationFilter>("all");
  const [sort, setSort] = useState<PublicationSort>("attention");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedTarget, setRequestedTarget] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const requests = useRef(new LatestRequest());

  const repositoryIds = useMemo(() => new Set(repositories.map((repo) => repo.id)), [repositories]);
  const repositoryScope = useMemo(() => [...repositoryIds].sort().join("\u0000"), [repositoryIds]);
  const rows = useMemo(() => repositories.map((repository) => ({
    repository, publication: getRepositoryPublication(repository.id, data),
  })), [repositories, data]);
  const counts = useMemo(() => getPublicationSummary(repositories, data), [repositories, data]);
  const canGenerate = canRecompile(kind, role);

  const refreshAll = useCallback(async () => {
    if (loadingRef.current) return;
    const request = requests.current.begin();
    loadingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const [prs, artifacts] = await Promise.all([
        apiFetch<{ revisionPrs: Record<string, unknown>[] }>("/api/revision-prs", { workspaceId, signal: request.signal }),
        apiFetch<{ compiledArtifacts: Record<string, unknown>[] }>("/api/compiled-artifacts", { workspaceId, signal: request.signal }),
      ]);
      if (!request.isCurrent()) return;
      setData(normalizePublicationData(prs.revisionPrs, artifacts.compiledArtifacts, repositoryIds));
      setLastFetchedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent() && !isAbortError(cause)) setError(getErrorMessage(cause instanceof ApiError ? cause.code : "INTERNAL_ERROR"));
    } finally {
      if (request.isCurrent()) {
        loadingRef.current = false;
        setRefreshing(false);
      }
    }
  }, [repositoryIds, workspaceId]);

  useEffect(() => {
    requests.current.invalidate();
    loadingRef.current = false;
    setData(initialData);
    setLastFetchedAt(initialFetchedAt);
    setRefreshing(false);
    setError(null);
    return () => requests.current.invalidate();
  }, [initialData, initialFetchedAt, projectId, repositoryScope, workspaceId]);

  const handleCardUpdated = useCallback(() => { void refreshAll(); }, [refreshAll]);
  // A filtered-out card is restored before following the next-action anchor.
  useEffect(() => {
    if (!requestedTarget || filter !== "all" || search.trim()) return;
    const target = document.getElementById(requestedTarget);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    setRequestedTarget(null);
  }, [requestedTarget, filter, search]);

  const selectSummary = (next: PublicationFilter) => {
    setSearch("");
    setFilter((current) => current === next ? "all" : next);
  };
  const metrics = [
    {
      value: "draft" as const, label: "Draft PR", count: counts.drafts,
      description: "開いているPR件数", Icon: GitPullRequest,
    },
    {
      value: "pending" as const, label: "検証待ち", count: counts.pending,
      description: "直近マージの検証待ち・記録なし", Icon: Clock3,
    },
    {
      value: "mismatch" as const, label: "不一致", count: counts.mismatch,
      description: "直近マージで不一致", Icon: AlertTriangle,
    },
    {
      value: "verified" as const, label: "検証済み", count: counts.verified,
      description: "直近マージの検証済み", Icon: CheckCircle2,
    },
  ];

  const sortedRows = [...rows].sort((a, b) => {
    if (sort === "name") return a.repository.fullName.localeCompare(b.repository.fullName);
    if (sort === "recent") return b.publication.latestAt - a.publication.latestAt ||
      a.repository.fullName.localeCompare(b.repository.fullName);
    return publicationAttentionRank(a.publication) - publicationAttentionRank(b.publication) ||
      b.publication.latestAt - a.publication.latestAt ||
      a.repository.fullName.localeCompare(b.repository.fullName);
  });
  const visible = sortedRows.filter((row) =>
    row.repository.fullName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
    matchesPublicationFilter(row.publication, filter));
  const visibleIds = new Set(visible.map((row) => row.repository.id));

  const prioritized = [...rows].sort((a, b) =>
    publicationAttentionRank(a.publication) - publicationAttentionRank(b.publication) ||
    b.publication.latestAt - a.publication.latestAt);
  const first = prioritized[0] as Item | undefined;
  const needsAttention = first && (
    first.publication.verification === "mismatch" ||
    first.publication.draftPrs.length > 0 ||
    first.publication.verification === "pending");
  const firstDraftUrl = first
    ? safePublicationPrUrl(first.publication.latestDraft?.prUrl, first.repository.fullName) : null;
  const primaryHref = first?.publication.verification === "mismatch"
    ? "#publication-verification-" + first.repository.id
    : first?.publication.draftPrs.length && firstDraftUrl
      ? firstDraftUrl
      : first?.publication.isUnrecorded && canGenerate
      ? "#publication-maintenance-" + first.repository.id
      : first ? "#publication-repo-" + first.repository.id : "#publication-repositories";
  const primaryLabel = first?.publication.verification === "mismatch"
    ? "不一致を確認"
    : first?.publication.draftPrs.length ? "Draft PRを確認"
    : first?.publication.verification === "pending" ? "検証状況を確認"
    : first?.publication.isUnrecorded && canGenerate ? "生成操作を確認" : "リポジトリを確認";
  const primaryDescription = first?.publication.verification === "mismatch"
    ? "直近のマージ済みPRの生成物に不一致があります。対象ファイルと根拠を確認してください。"
    : first?.publication.draftPrs.length
      ? "GitHubで確認・マージ待ちのDraft PRがあります。差分を確認してください。"
      : first?.publication.verification === "pending"
        ? "直近のマージ済みPRの検証が未完了、または検証記録がありません。状況を確認してください。"
        : first?.publication.isUnrecorded
      ? canGenerate
        ? "反映記録がないリポジトリがあります。生成ファイルの作成・更新が必要か確認してください。"
        : "反映記録がありません。生成操作にはメンテナー以上の権限が必要です。"
      : "現在、優先して確認するPRや検証の不一致はありません。リポジトリの記録を確認できます。";
  const externalPrimary = Boolean(first?.publication.verification !== "mismatch" &&
    first?.publication.draftPrs.length && firstDraftUrl);

  return <div className="publicationDashboard">
    <section className="publicationSummary" aria-label="反映状況の集計">
      {metrics.map((metric) => <button type="button" key={metric.value}
        className={"publicationSummaryMetric" + (filter === metric.value ? " selected" : "")}
        aria-pressed={filter === metric.value}
        onClick={() => selectSummary(metric.value)}>
        <span className="publicationMetricHead">
          <metric.Icon size={19} aria-hidden="true"/>
          <span>{metric.label}</span>
        </span>
        <strong>{metric.count}<small>件</small></strong>
        <span className="publicationMetricDescription">{metric.description}</span>
      </button>)}
    </section>
    <p className="publicationMetricFootnote">
      Draft PRはPR件数、検証はリポジトリの直近のマージ結果です。異なるPR世代の情報は合算せず、両者の件数は重複する場合があります。
    </p>

    {first && <section className="publicationNextAction" aria-label="次に確認すること">
      <div>
        <p className="publicationNextEyebrow">NEXT ACTION</p>
        <h2>{needsAttention ? "次に確認すること" : "現在の反映状況"}</h2>
        <p>{primaryDescription}</p>
        <span className="publicationNextRepository">{first.repository.fullName}</span>
      </div>
      {externalPrimary
        ? <a href={primaryHref} className="button primary" target="_blank" rel="noopener noreferrer">
            {primaryLabel}<ArrowUpRight size={16} aria-hidden="true"/>
          </a>
        : <button type="button" className="button primary"
            onClick={() => {
              setSearch(""); setFilter("all");
              setRequestedTarget(primaryHref.startsWith("#") ? primaryHref.slice(1) : null);
            }}>
            {primaryLabel}<ArrowUpRight size={16} aria-hidden="true"/>
          </button>}
    </section>}

    <section id="publication-repositories" className="publicationListing"
      aria-labelledby="publication-list-heading">
      <div className="publicationListHeader">
        <div>
          <h2 id="publication-list-heading">リポジトリごとの反映状況 <span>{repositories.length}件</span></h2>
          <p>Draft PR・マージ後の検証・生成物はそれぞれ異なる状態として表示します。</p>
        </div>
        <div className="publicationGlobalRefresh">
          <span>取得：{formatPublicationDate(lastFetchedAt, true)}</span>
          <button type="button" className="publicationRefresh" disabled={refreshing}
            onClick={() => { void refreshAll(); }}>
            <RefreshCw size={15} aria-hidden="true"/> {refreshing ? "取得中…" : "表示を更新"}
          </button>
        </div>
      </div>
      {error && <div className="publicationFetchError" role="alert">
        <p>{error}。前回取得した表示を維持しています。</p>
        <button type="button" onClick={() => { void refreshAll(); }}>再読み込み</button>
      </div>}
      <div className="publicationToolbar">
        <label className="publicationSearch">
          <span>リポジトリ名で検索</span>
          <span className="publicationSearchControl">
            <Search size={16} aria-hidden="true"/>
            <input type="search" placeholder="owner/repository"
              value={search} onChange={(event) => setSearch(event.target.value)}/>
          </span>
        </label>
        <label className="publicationToolbarField">
          <span>反映状態</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as PublicationFilter)}>
            {FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="publicationToolbarField">
          <span>並び替え</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PublicationSort)}>
            {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <div className="publicationResultMeta">
        <span role="status">表示 {visible.length}件 / 全{repositories.length}件</span>
        {(search || filter !== "all" || sort !== "attention") &&
          <button type="button" className="publicationClearFilter"
            onClick={() => { setSearch(""); setFilter("all"); setSort("attention"); }}>
            条件をクリア
          </button>}
      </div>
      {/* Keep running generation jobs mounted while their cards are filtered out. */}
      <div className="publicationGrid" hidden={!visible.length}>
        {sortedRows.map(({ repository, publication }) =>
          <div key={repository.id} hidden={!visibleIds.has(repository.id)}>
            <RepositoryPublicationCard
              repository={repository}
              publication={publication}
              workspaceId={workspaceId} projectId={projectId}
              kind={kind} role={role}
              onUpdated={handleCardUpdated}
            />
          </div>)}
      </div>
      {!visible.length && <div className="publicationEmptyFiltered">
            一致するリポジトリはありません。検索語や反映状態を変更してください。
          </div>}
    </section>
    <details className="publicationFlowGuide">
      <summary>承認からGitHubへの反映・検証までの流れ</summary>
      <ol>
        <li>ルールを承認する</li>
        <li>生成ファイルを作成する</li>
        <li>Draft PRをGitHubで確認する</li>
        <li>GitHubでPRをマージする</li>
        <li>マージ後の生成物の一致を検証する</li>
      </ol>
      <p>この工程は操作説明であり、個々のPRの完了状態を示すものではありません。検証済みはAIによるルール遵守を証明しません。</p>
      <Link href={`/w/${workspaceId}/projects/${projectId}/rules`}>ルール一覧を開く</Link>
    </details>
  </div>;
}
