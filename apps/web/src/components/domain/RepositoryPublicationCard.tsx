"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowUpRight, ChevronDown, ExternalLink, GitMerge, GitPullRequest, ShieldCheck } from "lucide-react";
import { githubRepositoryUrl } from "../../lib/github-repository-url.ts";
import { isAggregateArtifactPath, shortSha } from "../../lib/publication.ts";
import {
  formatPublicationDate, safePublicationPrUrl,
  type PublicationRepository, type RepositoryPublication,
} from "../../lib/publication-overview.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../shared/permissions.ts";
import { Badge, StatusBadge } from "../ui/index.tsx";
import { RecompileButton } from "./RecompileButton.tsx";

const INITIAL_ARTIFACT_LIMIT = 5;
const INITIAL_PR_HISTORY_LIMIT = 10;

export function RepositoryPublicationCard({
  repository, publication, workspaceId, projectId, kind, role, onUpdated,
}: {
  repository: PublicationRepository;
  publication: RepositoryPublication;
  workspaceId: string;
  projectId: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  onUpdated: () => void;
}) {
  const [showAllArtifacts, setShowAllArtifacts] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(publication.isUnrecorded);
  const {
    draftPrs, latestDraft, latestMerged, verification, hasMissingVerification,
    artifacts, allPrs, isUnrecorded,
  } = publication;
  const mismatchedPaths = latestMerged?.verification?.mismatchedPaths ?? [];
  const draftUrl = safePublicationPrUrl(latestDraft?.prUrl, repository.fullName);
  const mergedUrl = safePublicationPrUrl(latestMerged?.prUrl, repository.fullName);
  const githubUrl = githubRepositoryUrl(repository.fullName);
  const prefix = `/w/${workspaceId}/projects/${projectId}`;
  const verificationLabel = verification === "verified" ? "検証済み"
    : verification === "mismatch" ? "生成物に不一致"
    : hasMissingVerification ? "検証記録なし"
    : "検証待ち";
  const shownArtifacts = artifacts.slice(0, showAllArtifacts ? undefined : INITIAL_ARTIFACT_LIMIT);
  const sortedPrHistory = [...allPrs].sort((a, b) =>
    String(b.mergedAt ?? b.openedAt ?? b.createdAt ?? "").localeCompare(
      String(a.mergedAt ?? a.openedAt ?? a.createdAt ?? ""),
    ) || b.id.localeCompare(a.id));
  const shownHistory = sortedPrHistory.slice(0, showAllHistory ? undefined : INITIAL_PR_HISTORY_LIMIT);
  const otherDrafts = draftPrs.filter((pr) => pr.id !== latestDraft?.id);

  return <article id={`publication-repo-${repository.id}`}
    className="card publicationRepositoryCard">
    <header className="publicationRepositoryHeader">
      <div className="publicationRepositoryIdentity">
        <h3>{githubUrl
          ? <a href={githubUrl} target="_blank" rel="noopener noreferrer">
              {repository.fullName}<ExternalLink size={15} aria-hidden="true"/>
            </a>
          : repository.fullName}</h3>
        <p>デフォルトブランチ：<code>{repository.defaultBranch ?? "—"}</code></p>
      </div>
      <div className="publicationRepositoryBadges">
        {draftPrs.length > 0 && <Badge tone="blue">Draft PR {draftPrs.length}件</Badge>}
        {verification === "mismatch" && <Badge tone="red">不一致</Badge>}
        {verification === "pending" && <Badge tone="amber">検証待ち・記録なし</Badge>}
        {verification === "verified" && <Badge tone="green">最新マージ検証済み</Badge>}
        {isUnrecorded && <Badge tone="gray">反映記録なし</Badge>}
      </div>
    </header>

    <div className="publicationPrimaryGrid">
      <section className="publicationPrimaryPanel" aria-labelledby={`publication-draft-${repository.id}`}>
        <div className="publicationPanelHeading">
          <GitPullRequest size={18} aria-hidden="true"/>
          <h4 id={`publication-draft-${repository.id}`}>Draft PR</h4>
        </div>
        {latestDraft ? <>
          <div className="publicationPanelMain">
            <strong>#{String(latestDraft.prNumber ?? "—")}</strong>
            <span>GitHubでの確認・マージ待ち</span>
          </div>
          <div className="publicationPanelMeta">
            <span>作成：{formatPublicationDate(latestDraft.openedAt, true)}</span>
            {latestDraft.branch && <code>{latestDraft.branch}</code>}
          </div>
          {draftUrl
            ? <a href={draftUrl} target="_blank" rel="noopener noreferrer"
                className="publicationPanelAction">
                GitHubで差分を確認 <ArrowUpRight size={16} aria-hidden="true"/>
              </a>
            : <p className="publicationActionUnavailable">PRのリンクを確認できません。</p>}
          {otherDrafts.length > 0 && <details className="publicationSecondaryPrs">
            <summary>ほかのDraft PR {otherDrafts.length}件</summary>
            <div>{otherDrafts.map((pr) => {
              const url = safePublicationPrUrl(pr.prUrl, repository.fullName);
              return <p key={pr.id}>
                {url
                  ? <a href={url} target="_blank" rel="noopener noreferrer">#{String(pr.prNumber ?? "—")}</a>
                  : <span>#{String(pr.prNumber ?? "—")}</span>}
              </p>;
            })}</div>
          </details>}
        </> : <p className="publicationEmptyText">開いているDraft PRはありません。</p>}
      </section>

      <section id={`publication-verification-${repository.id}`}
        className={"publicationPrimaryPanel" + (verification === "mismatch" ? " hasMismatch" : "")}
        aria-labelledby={`publication-merge-${repository.id}`}>
        <div className="publicationPanelHeading">
          <GitMerge size={18} aria-hidden="true"/>
          <h4 id={`publication-merge-${repository.id}`}>マージ後の検証</h4>
        </div>
        {latestMerged ? <>
          <div className="publicationVerificationStatus">
            {verification === "verified"
              ? <ShieldCheck size={18} aria-hidden="true"/>
              : verification === "mismatch"
                ? <AlertTriangle size={18} aria-hidden="true"/>
                : null}
            {latestMerged.verification?.state === "verified" || latestMerged.verification?.state === "mismatch"
              ? <StatusBadge kind="verification" value={latestMerged.verification.state}/>
              : <Badge tone="amber">{verificationLabel}</Badge>}
          </div>
          <div className="publicationPanelMeta">
            <span>{mergedUrl
              ? <a href={mergedUrl} target="_blank" rel="noopener noreferrer">
                  マージ済みPR #{String(latestMerged.prNumber ?? "—")}
                </a>
              : <>マージ済みPR #{String(latestMerged.prNumber ?? "—")}</>}</span>
            <span>マージ：{formatPublicationDate(latestMerged.mergedAt, true)}</span>
            {latestMerged.verification?.checkedCommitSha && <span>
              確認commit <code>{shortSha(latestMerged.verification.checkedCommitSha)}</code>
            </span>}
          </div>
          {verification === "mismatch" && (mismatchedPaths.length > 0
            ? <details className="publicationMismatches" open>
                <summary>不一致の対象ファイル {mismatchedPaths.length}件 <ChevronDown size={14} aria-hidden="true"/></summary>
                <div className="publicationMismatchItems">{mismatchedPaths.map((path) =>
                  isAggregateArtifactPath(path)
                    ? <p key={path} className="publicationMismatchAggregate">
                        {path}：生成ファイルの再作成で修復用Draft PRにつながる場合があります。
                      </p>
                    : <Link key={path} href={`${prefix}/drift?type=artifact_mismatch&path=${encodeURIComponent(path)}`}>
                        {path}の指摘を確認 <ArrowUpRight size={14} aria-hidden="true"/>
                      </Link>)}</div>
              </details>
            : <Link className="publicationPanelAction"
                href={`${prefix}/drift?type=artifact_mismatch`}>
                ずれの指摘を確認 <ArrowUpRight size={16} aria-hidden="true"/>
              </Link>)}
        </> : <p className="publicationEmptyText">マージ済みPRの記録はありません。</p>}
      </section>
    </div>

    <details className="publicationArtifactsDisclosure">
      <summary>
        <span>生成物 <strong>{artifacts.length}件</strong>
          <small>保存されている生成ファイルと技術情報</small>
        </span>
        <ChevronDown size={18} aria-hidden="true"/>
      </summary>
      <div className="publicationArtifactsBody">
        {artifacts.length ? <>
          <div className="publicationArtifactsList">
            {shownArtifacts.map((artifact) => <div className="publicationArtifactEntry" key={artifact.id}>
              <div>
                <span className="publicationArtifactTarget">{artifact.target ?? "生成物"}</span>
                <code className="publicationArtifactPath">{artifact.path ?? "—"}</code>
              </div>
              <p>生成日時：{formatPublicationDate(artifact.generatedAt, true)}</p>
              <details className="publicationArtifactDetails">
                <summary>SHA・本文情報</summary>
                <p>Blob: <code>{shortSha(artifact.gitBlobSha)}</code></p>
                <p>Commit: <code>{shortSha(artifact.commitSha)}</code></p>
                {artifact.contentOmitted && <p>200KiB超のため本文は省略</p>}
              </details>
            </div>)}
          </div>
          {artifacts.length > INITIAL_ARTIFACT_LIMIT &&
            <button type="button" className="publicationShowMore"
              aria-expanded={showAllArtifacts}
              onClick={() => setShowAllArtifacts((value) => !value)}>
              {showAllArtifacts ? "直近5件に戻す" : "ほかの" + (artifacts.length - INITIAL_ARTIFACT_LIMIT) + "件を表示"}
            </button>}
        </> : <p className="publicationEmptyText">保存されている生成物はありません。</p>}
      </div>
    </details>

    {allPrs.length > 0 && <details className="publicationHistoryDisclosure">
      <summary>
        <span>PR履歴 <strong>{allPrs.length}件</strong></span>
        <ChevronDown size={17} aria-hidden="true"/>
      </summary>
      <div className="publicationHistoryList">
        {shownHistory.map((pr) => <div key={pr.id} className="publicationHistoryRow">
          <StatusBadge kind="revision_prs.status" value={pr.status}/>
          {safePublicationPrUrl(pr.prUrl, repository.fullName)
            ? <a href={safePublicationPrUrl(pr.prUrl, repository.fullName)!}
                target="_blank" rel="noopener noreferrer">PR #{String(pr.prNumber ?? "—")}</a>
            : <span>PR #{String(pr.prNumber ?? "—")}</span>}
          <span>{formatPublicationDate(pr.mergedAt ?? pr.openedAt ?? pr.createdAt, true)}</span>
        </div>)}
        {allPrs.length > INITIAL_PR_HISTORY_LIMIT &&
          <button type="button" className="publicationShowMore" aria-expanded={showAllHistory}
            onClick={() => setShowAllHistory((value) => !value)}>
            {showAllHistory ? "直近10件に戻す" : "ほかの" + (allPrs.length - INITIAL_PR_HISTORY_LIMIT) + "件を表示"}
          </button>}
      </div>
    </details>}

    <details className="publicationMaintenance" id={`publication-maintenance-${repository.id}`}
      open={maintenanceOpen}
      onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}>
      <summary>
        <span>生成ファイルの作成・再作成</span>
        <ChevronDown size={17} aria-hidden="true"/>
      </summary>
      <div className="publicationMaintenanceBody">
        <RecompileButton repositoryId={repository.id} workspaceId={workspaceId}
          kind={kind} role={role} hasDraftPr={draftPrs.length > 0} onUpdated={onUpdated}/>
      </div>
    </details>

    <footer className="publicationCardFootnote">
      検証済みはGitHub上の生成ファイルの整合性確認であり、AIが開発ルールを遵守したことの測定ではありません。
    </footer>
  </article>;
}
