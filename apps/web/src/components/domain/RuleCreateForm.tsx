"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { checksRequired, isValidRuleKey } from "../../lib/rule-form.ts";
import { Button, ErrorBanner, Select, TagInput, TextField } from "../ui/index.tsx";
import { ChecksJsonField } from "./ChecksJsonField.tsx";
import { emptySelector, SelectorFields, type RepositorySelectionMode } from "./SelectorFields.tsx";

const TYPE_LABELS: Record<string, string> = {
  policy: "ポリシー", guideline: "ガイドライン", workflow: "ワークフロー",
  architecture: "アーキテクチャ", security: "セキュリティ",
  "coding-style": "コーディングスタイル", interaction: "対話・コミュニケーション",
};
const MODE_LABELS: Record<string, string> = {
  deterministic: "決定的チェック", semantic: "意味評価", hybrid: "ハイブリッド",
};
const ENFORCEMENT_LABELS: Record<string, string> = {
  locked: "必須（組織）", default: "標準", advisory: "推奨",
};

export function RuleCreateForm({
  workspaceId, projectId, repositories, writable,
}: {
  workspaceId: string;
  projectId?: string;
  repositories?: { id: string; fullName: string }[];
  writable: boolean;
}) {
  const router = useRouter();
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const org = !projectId;
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [layer, setLayer] = useState("L3");
  const [type, setType] = useState("guideline");
  const [evaluationMode, setMode] = useState("semantic");
  const [enforcement, setEnforcement] = useState("default");
  const [selector, setSelector] = useState(emptySelector);
  const [repositoryMode, setRepositoryMode] = useState<RepositorySelectionMode>("all");
  const [tags, setTags] = useState<string[]>([]);
  const [watchDependencies, setWatchDependencies] = useState<string[]>([]);
  const [checks, setChecks] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const titleError = attempted && !title.trim() ? "タイトルを入力してください。" : null;
  const keyError = attempted && !isValidRuleKey(key)
    ? "キーは小文字の英数字で開始し、英数字・ピリオド・ハイフン・アンダースコアの100文字以内で入力してください。"
    : null;
  const listHref = projectId
    ? `/w/${workspaceId}/projects/${projectId}/rules`
    : `/w/${workspaceId}/rules`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!writable || loading) return;
    setAttempted(true);
    setChecksError(null);
    setScopeError(null);
    setError(null);
    if (!title.trim() || !isValidRuleKey(key)) return;
    if (repositoryMode === "specific" && !selector.repositoryIds.length) {
      setScopeError("対象リポジトリを1件以上選択してください。");
      if (advancedRef.current) advancedRef.current.open = true;
      return;
    }

    let parsed: Record<string, unknown>[] = [];
    if (evaluationMode === "deterministic" || (evaluationMode === "hybrid" && checks.trim())) {
      try {
        const value: unknown = JSON.parse(checks);
        if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error();
        parsed = value as Record<string, unknown>[];
      } catch {
        setChecksError("実行チェックをJSON配列で入力してください。例を挿入して編集できます。");
        if (advancedRef.current) advancedRef.current.open = true;
        return;
      }
    }
    if (checksRequired(evaluationMode, parsed)) {
      setChecksError("決定的チェックには、少なくとも1件のチェック定義が必要です。");
      if (advancedRef.current) advancedRef.current.open = true;
      return;
    }

    setLoading(true);
    try {
      const rule = await apiFetch<{ id: string }>("/api/rules", {
        method: "POST",
        workspaceId,
        body: {
          key, title: title.trim(), layer, type, evaluationMode, enforcement,
          visibility: "private", scopeType: org ? "organization" : "project",
          scopeId: org ? workspaceId : projectId, projectId: projectId ?? null,
          selector, tags, maintenance: { watchDependencies }, checks: parsed,
        },
      });
      setCreated(rule.id);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    const firstVersionPath = projectId
      ? `/w/${workspaceId}/projects/${projectId}/rules/${created}/versions/new`
      : `/w/${workspaceId}/rules/${created}/versions/new`;
    return <div className="ruleCreateComplete" role="status">
      <p className="ruleCreateStepEyebrow">{org ? "基本設定の保存完了" : "STEP 1 / 2 完了"}</p>
      <h2>ルールの基本設定を保存しました</h2>
      <p>次は初版の本文と根拠を登録します。基本設定だけではルールの作成は完了しません。</p>
      <Button type="button" onClick={() => router.push(firstVersionPath)}>
        初版本文を登録する
      </Button>
    </div>;
  }

  return <form className="formCard ruleCreateForm" noValidate onSubmit={(event) => void submit(event)}>
    <div className="ruleCreateStepHeader">
      <span className="ruleCreateStepEyebrow">{org ? "組織ルール" : "STEP 1 / 2"}</span>
      <h2>ルールの基本設定</h2>
      <p>{org ? "組織ルールの適用基準を設定します。" : "基本設定を保存した後、次の画面で初版本文と根拠を登録します。"}</p>
    </div>
    {!writable && <div className="noticeBanner warning" role="status">
      このWorkspaceでルールを作成する権限がありません。閲覧は可能です。
    </div>}
    <div className="formGrid">
      <div className="ruleField">
        <TextField label="タイトル（必須）" value={title}
          placeholder="例：セッションCookieの有効期限" maxLength={160}
          aria-invalid={Boolean(titleError)}
          onChange={(event) => setTitle(event.target.value)}/>
        {titleError && <small className="formError">{titleError}</small>}
      </div>
      <div className="ruleField">
        <TextField label="ルールキー（必須）" value={key}
          placeholder="security.auth-session" maxLength={100}
          aria-invalid={Boolean(keyError)}
          onChange={(event) => setKey(event.target.value)}/>
        {keyError && <small className="formError">{keyError}</small>}
      </div>
      <Select label="レイヤー" value={layer} onChange={(event) => setLayer(event.target.value)}>
        <option value="L1">L1：哲学・方針</option>
        <option value="L2">L2：意思決定基準</option>
        <option value="L3">L3：具体的なガイドライン</option>
      </Select>
      <Select label="種別" value={type} onChange={(event) => setType(event.target.value)}>
        {Object.entries(TYPE_LABELS).map(([value, label]) =>
          <option key={value} value={value}>{label}</option>)}
      </Select>
      <Select label="適用レベル" value={enforcement} onChange={(event) => setEnforcement(event.target.value)}>
        {(org ? ["locked", "default", "advisory"] : ["default", "advisory"]).map((value) =>
          <option key={value} value={value}>{ENFORCEMENT_LABELS[value]}</option>)}
      </Select>
    </div>

    <details className="ruleCreateAdvanced" ref={advancedRef}>
      <summary>適用対象・評価方法などの詳細設定（任意）</summary>
      <div className="ruleCreateAdvancedBody">
        <Select label="評価方法" value={evaluationMode} onChange={(event) => { setMode(event.target.value); setChecksError(null); }}>
          {Object.entries(MODE_LABELS).map(([value, label]) =>
            <option key={value} value={value}>{label}</option>)}
        </Select>
        {evaluationMode !== "semantic" && <div className="ruleCreateChecks">
          {evaluationMode === "hybrid" && <p className="formHint">意味評価に加えて実行するチェックを指定できます。未指定の場合は意味評価のみ行います。</p>}
          <ChecksJsonField value={checks} onChange={(value) => { setChecks(value); setChecksError(null); }} error={checksError}/>
          <button type="button" className="ruleTemplateButton" onClick={() => setChecks(JSON.stringify([
            { kind: "regex", spec: { pattern: "^foo$" }, severityOnFail: "error" },
          ], null, 2))}>JSONの入力例を挿入</button>
        </div>}
        {evaluationMode === "semantic" && checks.trim() && <p className="formHint">意味評価ではチェック定義を保存しません。ハイブリッドまたは決定的チェックに戻すと入力内容を使用できます。</p>}
        <SelectorFields value={selector} onChange={(next) => { setSelector(next); setScopeError(null); }}
          repositories={projectId ? repositories : undefined} repositoryMode={repositoryMode}
          onRepositoryModeChange={(next) => { setRepositoryMode(next); setScopeError(null); }}/>
        {scopeError && <p className="formError" role="alert">{scopeError}</p>}
        <div className="formGroup">
          <span>タグ</span>
          <TagInput value={tags} onChange={setTags}/>
        </div>
        <div className="formGroup">
          <span>変更を監視する依存関係</span>
          <TagInput value={watchDependencies} onChange={setWatchDependencies} inputLabel="変更を監視する依存関係を入力" maxItems={50} caseSensitive/>
          <p className="formHint">パッケージ名を入力してEnterで追加します。未指定の場合は監視しません。</p>
        </div>
        <p className="formHint">公開範囲はprivate固定です。閲覧できるのはWorkspaceのメンバーです。</p>
      </div>
    </details>

    {error && <ErrorBanner code={error}/>}
    <div className="formActions ruleCreateActions">
      <Link className="button secondary" href={listHref}>キャンセル</Link>
      <Button type="submit" disabled={!writable || loading} loading={loading}>
        {org ? "組織ルールを作成" : "基本設定を保存して本文へ"}
      </Button>
    </div>
  </form>;
}
