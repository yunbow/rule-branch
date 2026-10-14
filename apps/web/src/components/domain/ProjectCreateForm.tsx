"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Search } from "lucide-react";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { suggestProjectSlug, validateProjectSlug } from "../../lib/project-creation.ts";
import { Button, ErrorBanner, TagInput } from "../ui/index.tsx";
import { InstallationSelect, type InstallationOption } from "./InstallationSelect.tsx";

type Repo = { id: string | number; full_name: string; default_branch?: string };

export function ProjectCreateForm({
  workspaceId,
  installations,
  initialInstallationId,
}: {
  workspaceId: string;
  installations: InstallationOption[];
  initialInstallationId?: string;
}) {
  const router = useRouter();
  const eligible = useMemo(() => installations.filter((item) => item.repositorySelection === "selected"), [installations]);
  const [name, setName] = useState("");
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState(false);
  const [description, setDescription] = useState("");
  const [installationId, setInstallationId] = useState(() => initialInstallationId ??
    (eligible.length === 1 ? eligible[0].id : ""));
  const [repositories, setRepositories] = useState<Repo[]>([]);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repoReload, setRepoReload] = useState(0);
  const [repoQuery, setRepoQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [primaryLanguages, setPrimaryLanguages] = useState<string[]>([]);
  const [frameworks, setFrameworks] = useState<string[]>([]);
  const [focusThemes, setFocusThemes] = useState<string[]>([]);
  const [companionProfile, setCompanionProfile] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [slugConflict, setSlugConflict] = useState(false);
  const [loading, setLoading] = useState(false);

  const installation = eligible.find((item) => item.id === installationId);
  useEffect(() => {
    let active = true;
    setRepositories([]);
    setSelected([]);
    setRepoQuery("");
    setRepoError(null);
    setRepoLoading(Boolean(installation));
    if (!installation) return;
    void apiFetch<{ repositories: Repo[] }>(`/api/installations/${installation.githubInstallationId}/repositories`)
      .then((result) => {
        if (!active) return;
        setRepositories(result.repositories);
        setRepoLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRepoLoading(false);
        setRepoError(error instanceof ApiError ? error.code : "INTERNAL_ERROR");
      });
    return () => { active = false; };
  }, [installation, repoReload]);

  const selectedRepoNames = repositories
    .filter((repo) => selected.includes(String(repo.id)))
    .map((repo) => repo.full_name);
  const suggestedSlug = suggestProjectSlug(name, selectedRepoNames);
  const slug = slugOverride ?? suggestedSlug;
  const matchingRepos = repositories.filter((repo) =>
    repo.full_name.toLocaleLowerCase().includes(repoQuery.trim().toLocaleLowerCase()),
  );
  const selectedSet = new Set(selected);
  const nameError = attempted && !name.trim() ? "プロジェクト名を入力してください。" : null;
  const slugError = slugConflict ? "このスラッグは既に使われています。別の文字列を指定してください。"
    : attempted || slugOverride !== null ? validateProjectSlug(slug) : null;
  const installationError = attempted && !installation ? "GitHub連携を選択してください。" : null;
  const selectionError = attempted && !selected.length ? "解析対象のリポジトリを1件以上選択してください。" : null;
  const listHref = `/w/${workspaceId}/projects`;

  const toggleRepo = (id: string, checked: boolean) => {
    setSelected((current) => checked
      ? current.includes(id) ? current : [...current, id]
      : current.filter((value) => value !== id));
    if (slugOverride === null) setSlugConflict(false);
  };
  const selectVisible = () => {
    setSelected((current) => [...new Set([
      ...current, ...matchingRepos.map((repo) => String(repo.id)),
    ])]);
    if (slugOverride === null) setSlugConflict(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setAttempted(true);
    setServerError(null);
    if (!name.trim() || !installation || repoLoading || repoError ||
      !selected.length || validateProjectSlug(slug) || slugConflict) {
      if (validateProjectSlug(slug) || slugConflict) setEditingSlug(true);
      return;
    }
    setLoading(true);
    let created = false;
    try {
      const project = await apiFetch<{ id: string }>("/api/projects", {
        method: "POST",
        workspaceId,
        body: {
          name: name.trim(),
          slug,
          description: description.trim() || null,
          installationId,
          repositoryGithubIds: selected,
          primaryLanguages,
          frameworks,
          focusThemes,
          companionProfile: companionProfile.trim() ? { instructions: companionProfile.trim() } : undefined,
        },
      });
      created = true;
      router.push(`/w/${workspaceId}/projects/${project.id}?job=bootstrap`);
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : "INTERNAL_ERROR";
      if (code === "UNIQUE_VIOLATION" &&
        (reason instanceof ApiError && (reason.details as { kind?: string } | undefined)?.kind === "project_slug")) {
        setSlugConflict(true);
        setEditingSlug(true);
      } else {
        setServerError(code);
      }
    } finally {
      if (!created) setLoading(false);
    }
  };

  return <form className="projectCreateForm" noValidate onSubmit={(event) => void submit(event)}>
    <div className="projectCreateSection">
      <div className="projectCreateSectionHeader">
        <span className="projectCreateStepNumber">1</span>
        <div>
          <h2>基本情報</h2>
          <p>まずは管理するプロジェクトの名前を入力します。</p>
        </div>
      </div>
      <label className="formField" htmlFor="project-create-name">
        <span>プロジェクト名 <span className="projectRequired">必須</span></span>
        <input
          className="formControl"
          id="project-create-name"
          type="text"
          maxLength={120}
          autoComplete="off"
          value={name}
          onChange={(event) => { setName(event.target.value); if (slugOverride === null) setSlugConflict(false); }}
          placeholder="例：社内サービス開発"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? "project-create-name-error" : undefined}
        />
        {nameError && <small className="formError" id="project-create-name-error">{nameError}</small>}
      </label>
      <div className="projectSlugSection">
        <span className="projectSlugLabel">スラッグ（プロジェクトの識別子）</span>
        {!editingSlug
          ? <div className="projectSlugPreview">
              <code>{slug || "未生成"}</code>
              <button type="button" onClick={() => setEditingSlug(true)}>変更する</button>
            </div>
          : <div className="projectSlugEdit">
              <input type="text" className="formControl" value={slug} maxLength={100}
                aria-label="スラッグ" aria-invalid={Boolean(slugError)}
                aria-describedby={slugError ? "project-create-slug-error" : "project-create-slug-help"}
                onChange={(event) => { setSlugOverride(event.target.value.normalize("NFKC").toLowerCase()); setSlugConflict(false); }}
                placeholder="例：internal-service"/>
              <button type="button" onClick={() => { setSlugOverride(null); setSlugConflict(false); }}>
                自動生成に戻す
              </button>
            </div>}
        <small className="formHint" id="project-create-slug-help">名前が日本語の場合は、選択したリポジトリ名から英数字のスラッグを提案します。</small>
        {slugError && <small className="formError" id="project-create-slug-error">{slugError}</small>}
      </div>
    </div>

    <div className="projectCreateSection">
      <div className="projectCreateSectionHeader">
        <span className="projectCreateStepNumber">2</span>
        <div>
          <h2>GitHubリポジトリ</h2>
          <p>初回解析の対象を1件以上選択してください。</p>
        </div>
      </div>
      <div className="projectCreateInstallation">
        <InstallationSelect installations={eligible} value={installationId}
          onChange={(id) => { setInstallationId(id); setServerError(null); }}
          label="GitHub連携（必須）"/>
        {installationError && <small className="formError">{installationError}</small>}
      </div>
      {installation && <>
        <div className="projectCreateRepoHeader">
          <label htmlFor="project-create-repo-search">解析対象リポジトリ <span className="projectRequired">必須</span></label>
          <strong>{selected.length}件選択中</strong>
        </div>
        <div className="projectCreateRepoSelector">
          <div className="projectCreateRepoToolbar">
            <div className="projectCreateRepoSearch">
              <Search size={16} aria-hidden="true"/>
              <input id="project-create-repo-search" type="search" value={repoQuery}
                disabled={repoLoading || Boolean(repoError)}
                placeholder="リポジトリ名で検索" onChange={(event) => setRepoQuery(event.target.value)}/>
            </div>
            <div className="projectCreateRepoControls">
              <button type="button" onClick={selectVisible}
                disabled={repoLoading || Boolean(repoError) || !matchingRepos.length}>表示中を全選択</button>
              <button type="button" onClick={() => { setSelected([]); if (slugOverride === null) setSlugConflict(false); }} disabled={!selected.length}>選択解除</button>
            </div>
          </div>
          {repoLoading
            ? <div role="status" className="projectCreateRepoState">リポジトリを読み込み中です…</div>
            : repoError
              ? <div className="projectCreateRepoState" role="alert">
                  <p>{getErrorMessage(repoError)}</p>
                  <button type="button" onClick={() => setRepoReload((count) => count + 1)}>再読み込み</button>
                </div>
              : repositories.length === 0
                ? <div className="projectCreateRepoState">
                    <p>選択できるリポジトリがありません。GitHub Appの権限を確認してください。</p>
                    <Link href={`/w/${workspaceId}/install`}>GitHub Appの設定へ</Link>
                  </div>
                : matchingRepos.length === 0
                  ? <div className="projectCreateRepoState">検索条件に一致するリポジトリはありません。</div>
                  : <div className="projectCreateRepoOptions" role="group" aria-label="解析対象のリポジトリ">
                      {matchingRepos.map((repo) => {
                        const id = String(repo.id);
                        return <label className={`projectCreateRepoOption${selectedSet.has(id) ? " selected" : ""}`} key={id}>
                          <input type="checkbox" checked={selectedSet.has(id)}
                            onChange={(event) => toggleRepo(id, event.target.checked)}/>
                          <span className="projectCreateRepoLabel">
                            <strong>{repo.full_name}</strong>
                            {repo.default_branch && <small>既定ブランチ：{repo.default_branch}</small>}
                          </span>
                          {selectedSet.has(id) && <Check size={17} aria-hidden="true"/>}
                        </label>;
                      })}
                    </div>}
        </div>
        {selectionError && <small className="formError">{selectionError}</small>}
      </>}
    </div>

    <details className="projectCreateAdvanced">
      <summary>
        <span><strong>詳細設定（任意）</strong><small>必要な場合だけ、説明・技術スタック・AI Companionへの補足指示を入力します。</small></span>
        <ChevronDown size={19} aria-hidden="true"/>
      </summary>
      <div className="projectCreateAdvancedFields">
        <label className="formField" htmlFor="project-create-description">
          <span>プロジェクトの説明</span>
          <textarea className="formControl" id="project-create-description" rows={3}
            placeholder="プロジェクトの役割や対象範囲" value={description}
            onChange={(event) => setDescription(event.target.value)}/>
        </label>
        <div className="projectCreateTagsGrid">
          <TagInput label="主要言語" value={primaryLanguages} maxItems={20} onChange={setPrimaryLanguages}
            variant="inline" placeholder="入力してEnterで追加" commitKeys={["Enter", ","]} commitOnBlur inputMaxLength={100}/>
          <TagInput label="フレームワーク" value={frameworks} maxItems={20} onChange={setFrameworks}
            variant="inline" placeholder="入力してEnterで追加" commitKeys={["Enter", ","]} commitOnBlur inputMaxLength={100}/>
          <TagInput label="注目テーマ" value={focusThemes} maxItems={10} onChange={setFocusThemes}
            variant="inline" placeholder="入力してEnterで追加" commitKeys={["Enter", ","]} commitOnBlur inputMaxLength={100}/>
        </div>
        <label className="formField" htmlFor="project-create-companion">
          <span>AI Companionへの補足指示</span>
          <textarea className="formControl" id="project-create-companion" rows={3}
            placeholder="ルール提案時に重視するプロジェクト固有の前提"
            value={companionProfile} onChange={(event) => setCompanionProfile(event.target.value)}/>
        </label>
      </div>
    </details>

    {serverError && <div className="projectCreateServerError">
      <ErrorBanner code={serverError}/>
      <p>作成処理が途中まで進んだ可能性があります。再試行する前に<Link href={listHref}>一覧で作成状況を確認</Link>してください。</p>
    </div>}
    <div className="projectCreateActions">
      <Link className="button secondary" href={listHref}>キャンセル</Link>
      <Button type="submit" loading={loading} disabled={loading || repoLoading || Boolean(repoError)}>
        作成して初回解析を開始 <ArrowRight size={16} aria-hidden="true"/>
      </Button>
    </div>
  </form>;
}
