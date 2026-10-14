"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { utf8ByteLength } from "../../lib/rule-form.ts";
import {
  CHANGE_TYPE_DESCRIPTION,
  MAX_VERSION_CONTENT_BYTES,
  MAX_VERSION_EVIDENCE,
  MAX_VERSION_RATIONALE_BYTES,
  createVersionErrorMessage,
  parseEvidenceIdInput,
  uniqueEvidenceIds,
  validateVersionCreate,
} from "../../lib/version-create.ts";
import { Button, Markdown, Select, StatusBadge } from "../ui/index.tsx";
import { PageSection } from "../ui/Page.tsx";
import { EvidenceList } from "./EvidenceList.tsx";
import { VersionDiff } from "./VersionDiff.tsx";
import "./version-create-form.css";

type Initial = {
  content: string;
  rationale: string;
  evidenceIds: string[];
  compatibility: unknown;
  changeType: string;
};
type SourceVersion = {
  id: string;
  number: string;
  status: string;
  sourceType: string;
  content: string;
  rationale: string;
};
type CurrentVersion = { id: string; number: string; content: string };
type DisplayMode = "edit" | "preview" | "source-diff" | "current-diff";

const CHANGE_LABELS: Record<string, string> = {
  initial: "新規",
  clarify: "明確化",
  tighten: "強化",
  relax: "緩和",
  refactor: "整理",
  deprecate: "廃止",
};

export function VersionCreateForm({
  workspaceId,
  projectId,
  ruleId,
  initial,
  sourceVersion,
  currentVersion,
  repositories,
  writable,
  replaceSource = true,
}: {
  workspaceId: string;
  projectId?: string;
  ruleId: string;
  initial: Initial;
  sourceVersion: SourceVersion | null;
  currentVersion: CurrentVersion | null;
  repositories: { id: string; fullName: string }[];
  writable: boolean;
  replaceSource?: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState(initial.content);
  const [rationale, setRationale] = useState(initial.rationale);
  const [evidenceIds, setEvidenceIds] = useState(() => uniqueEvidenceIds(initial.evidenceIds));
  const [evidenceInput, setEvidenceInput] = useState("");
  const [evidenceInputError, setEvidenceInputError] = useState<string | null>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const [compatibility, setCompatibility] = useState(() => JSON.stringify(initial.compatibility ?? {}, null, 2));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [changeType, setChangeType] = useState(initial.changeType);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("edit");
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; sourceChanged: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const sendingRef = useRef(false);

  const ruleHref = "/w/" + workspaceId + (projectId ? "/projects/" + projectId : "") + "/rules/" + ruleId;
  const sourceHref = sourceVersion
    ? ruleHref + "/versions/" + sourceVersion.id
    : null;
  const backHref = sourceHref ?? ruleHref;
  const originalCompatibility = JSON.stringify(initial.compatibility ?? {}, null, 2);
  const dirty = content !== initial.content
    || rationale !== initial.rationale
    || changeType !== initial.changeType
    || compatibility !== originalCompatibility
    || Boolean(evidenceInput.trim())
    || evidenceIds.join(",") !== uniqueEvidenceIds(initial.evidenceIds).join(",");

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  const validation = validateVersionCreate({
    content,
    rationale,
    evidenceIds,
    compatibilityJson: compatibility,
    sourceStatus: replaceSource ? sourceVersion?.status : undefined,
  });
  const contentBytes = utf8ByteLength(content);
  const rationaleBytes = utf8ByteLength(rationale);
  const canCompareSource = Boolean(sourceVersion);
  const canCompareCurrent = Boolean(currentVersion && currentVersion.id !== sourceVersion?.id);

  const confirmNavigation = (): boolean => !dirty || window.confirm("未保存の変更を破棄して移動しますか？");
  const goBack = () => {
    if (loading || !confirmNavigation()) return;
    router.push(backHref);
  };
  const addEvidence = () => {
    const ids = parseEvidenceIdInput(evidenceInput);
    if (!ids.length) {
      setEvidenceInputError("追加する根拠IDを入力してください。");
      return;
    }
    const next = uniqueEvidenceIds([...evidenceIds, ...ids]);
    if (next.length > MAX_VERSION_EVIDENCE) {
      setEvidenceInputError("根拠は最大20件まで指定できます。");
      return;
    }
    setEvidenceIds(next);
    setEvidenceInput("");
    setEvidenceInputError(null);
  };
  const formatCompatibility = () => {
    if (validation.compatibilityError || !validation.compatibilityValue) {
      setAttempted(true);
      setAdvancedOpen(true);
      return;
    }
    setCompatibility(JSON.stringify(validation.compatibilityValue, null, 2));
  };
  const submit = async () => {
    if (!writable || loading || sendingRef.current) return;
    setAttempted(true);
    setServerError(null);
    if (evidenceInput.trim()) {
      setEvidenceInputError("入力した根拠IDがまだ追加されていません。「追加」を押すか、入力欄を空にしてください。");
      const input = evidenceInputRef.current;
      input?.closest("details")?.setAttribute("open", "");
      input?.focus();
      return;
    }
    if (!validation.valid || !validation.compatibilityValue) {
      if (validation.compatibilityError) setAdvancedOpen(true);
      return;
    }
    sendingRef.current = true;
    setLoading(true);
    try {
      const version = await apiFetch<{ id: string }>("/api/rule-versions", {
        method: "POST",
        workspaceId,
        body: {
          ruleId,
          content,
          rationale,
          evidenceIds,
          compatibility: validation.compatibilityValue,
          changeType,
          provenance: { sourceType: "human" },
          supersedes: replaceSource ? sourceVersion?.id ?? null : null,
        },
      });
      router.push(ruleHref + "/versions/" + version.id);
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : "INTERNAL_ERROR";
      setServerError({
        message: createVersionErrorMessage(code) ?? getErrorMessage(code),
        sourceChanged: code === "SUPERSEDES_INVALID",
      });
    } finally {
      sendingRef.current = false;
      setLoading(false);
    }
  };

  return <div className="sectionStack versionCreateForm">
    {sourceVersion && <div className="versionCreateContext">
      <div className="versionCreateContextInfo">
        <span className="versionCreateEyebrow">修正元のバージョン</span>
        <div className="inlineActions">
          <strong>Version v{sourceVersion.number}</strong>
          <StatusBadge kind="rule_versions.status" value={sourceVersion.status}/>
          <StatusBadge kind="provenance" value={sourceVersion.sourceType}/>
        </div>
        <p>元バージョンを参照しながら、新しいレビュー対象のバージョンを作成します。</p>
      </div>
      {sourceHref && <Link href={sourceHref} className="button secondary"
        onClick={(event) => { if (loading || !confirmNavigation()) event.preventDefault(); }}>
        元バージョンを見る
      </Link>}
    </div>}
    {validation.sourceError && <div role="alert" className="noticeBanner warning versionCreateBanner">
      {validation.sourceError} 修正版への置き換えは、元の提案が「提案中」のときだけ可能です。
    </div>}
    {!writable && <div role="alert" className="noticeBanner warning versionCreateBanner">
      このWorkspaceではバージョンを作成する権限がありません。
    </div>}

    <PageSection title="ルール本文" description="編集・プレビュー・差分を切り替えながら変更内容を確認できます。">
      <div className="segmentedTabs versionCreateTabs" role="group" aria-label="ルール本文の表示">
        <Button type="button" variant="ghost" aria-pressed={displayMode === "edit"}
          className={displayMode === "edit" ? "active" : ""} onClick={() => setDisplayMode("edit")}>編集</Button>
        <Button type="button" variant="ghost" aria-pressed={displayMode === "preview"}
          className={displayMode === "preview" ? "active" : ""} onClick={() => setDisplayMode("preview")}>プレビュー</Button>
        {canCompareSource && <Button type="button" variant="ghost" aria-pressed={displayMode === "source-diff"}
          className={displayMode === "source-diff" ? "active" : ""} onClick={() => setDisplayMode("source-diff")}>元バージョンとの差分</Button>}
        {canCompareCurrent && <Button type="button" variant="ghost" aria-pressed={displayMode === "current-diff"}
          className={displayMode === "current-diff" ? "active" : ""} onClick={() => setDisplayMode("current-diff")}>現行版との差分</Button>}
      </div>
      {displayMode === "edit" && <div className="formGroup versionCreateEditor">
        <label className="versionCreateFieldLabel" htmlFor="new-version-content">ルール本文 <span>必須</span></label>
        <textarea id="new-version-content" className="formControl versionCreateContentInput"
          rows={18} value={content} disabled={!writable || loading}
          aria-invalid={attempted && Boolean(validation.contentError)}
          aria-describedby="new-version-content-help"
          placeholder="ルール本文をMarkdownで入力してください"
          onChange={(event) => setContent(event.target.value)}/>
        <small id="new-version-content-help" className={contentBytes > MAX_VERSION_CONTENT_BYTES ? "formError" : "formHint"} aria-live="polite">
          {contentBytes.toLocaleString()} / {MAX_VERSION_CONTENT_BYTES.toLocaleString()} bytes
        </small>
      </div>}
      {displayMode === "preview" && <div className="versionCreatePreview contentPanel" aria-label="ルール本文のプレビュー">
        {content.trim() ? <Markdown>{content}</Markdown> : <p className="formNote">プレビューする本文がありません。</p>}
      </div>}
      {displayMode === "source-diff" && sourceVersion && <div className="versionCreateDiff">
        <p className="versionCreateSubnote">比較対象：元バージョン v{sourceVersion.number} → 編集中の本文</p>
        <VersionDiff currentVersionId={sourceVersion.id} currentContent={sourceVersion.content}
          content={content} comparisonLabel="元バージョンとの差分"/>
      </div>}
      {displayMode === "current-diff" && currentVersion && <div className="versionCreateDiff">
        <p className="versionCreateSubnote">比較対象：現行版 v{currentVersion.number} → 編集中の本文</p>
        <VersionDiff currentVersionId={currentVersion.id} currentContent={currentVersion.content}
          content={content} comparisonLabel="現行版との差分"/>
      </div>}
      {(attempted && validation.contentError) && <p role="alert" className="formError">{validation.contentError}</p>}
    </PageSection>

    <PageSection title="今回の変更" description="元バージョンから何を変更し、なぜ変更したかを記録します。">
      <div className="versionCreateChangeGrid">
        <div className="formGroup">
          <label className="versionCreateFieldLabel" htmlFor="new-version-rationale">今回の変更理由 <span>必須</span></label>
          <textarea id="new-version-rationale" rows={6} value={rationale}
            className="formControl versionCreateReasonInput" disabled={!writable || loading}
            aria-invalid={attempted && Boolean(validation.rationaleError)}
            aria-describedby="new-version-rationale-help"
            placeholder="例：対象ディレクトリと例外条件を明記し、適用範囲を明確にしました。"
            onChange={(event) => setRationale(event.target.value)}/>
          <small id="new-version-rationale-help" className={rationaleBytes > MAX_VERSION_RATIONALE_BYTES ? "formError" : "formHint"} aria-live="polite">
            {rationaleBytes.toLocaleString()} / {MAX_VERSION_RATIONALE_BYTES.toLocaleString()} bytes
          </small>
          {attempted && validation.rationaleError && <p role="alert" className="formError">{validation.rationaleError}</p>}
        </div>
        <div className="formGroup">
          <Select label="変更種別" value={changeType} disabled={!writable || loading}
            onChange={(event) => setChangeType(event.target.value)}>
            {Object.entries(CHANGE_LABELS).map(([value, label]) =>
              <option key={value} value={value}>{label}</option>)}
          </Select>
          <p className="formNote">{CHANGE_TYPE_DESCRIPTION[changeType] ?? "変更内容に合った種別を指定してください。"}</p>
        </div>
      </div>
      {sourceVersion?.rationale && <details className="versionCreateReference">
        <summary>元バージョンの変更理由を参照する</summary>
        <p>{sourceVersion.rationale}</p>
        <Button type="button" variant="secondary" disabled={!writable || loading}
          onClick={() => setRationale(sourceVersion.rationale)}>元の理由を入力欄へコピー</Button>
      </details>}
    </PageSection>

    <PageSection title="根拠コード" description="引き継いだ根拠を確認できます。除外はこの版との紐付けだけを外し、根拠データ自体は削除しません。">
      <p className="versionCreateSubnote">選択中の根拠：{evidenceIds.length} / {MAX_VERSION_EVIDENCE} 件</p>
      <EvidenceList workspaceId={workspaceId} evidenceIds={evidenceIds} repositories={repositories}
        onRemove={writable && !loading
          ? (id) => setEvidenceIds((existing) => existing.filter((item) => item !== id))
          : undefined}/>
      {attempted && validation.evidenceError && <p role="alert" className="formError">{validation.evidenceError}</p>}
      <details className="versionCreateReference">
        <summary>根拠IDを指定して追加（詳細操作）</summary>
        <p className="formNote">IDをカンマまたは改行で区切って指定します。既存のIDは重複登録されません。</p>
        <div className="versionCreateEvidenceAdd">
          <label className="formField" htmlFor="new-version-evidence">
            <span>根拠ID</span>
            <input ref={evidenceInputRef} id="new-version-evidence" className="formControl" value={evidenceInput}
              disabled={!writable || loading} placeholder="evidence-1, evidence-2"
              aria-invalid={Boolean(evidenceInputError)}
              aria-describedby={evidenceInputError ? "new-version-evidence-error" : undefined}
              onChange={(event) => { setEvidenceInput(event.target.value); setEvidenceInputError(null); }}/>
          </label>
          <Button type="button" variant="secondary" disabled={!writable || loading}
            onClick={addEvidence}>追加</Button>
        </div>
        {evidenceInputError && <p id="new-version-evidence-error" role="alert" className="formError">{evidenceInputError}</p>}
      </details>
    </PageSection>

    <PageSection title="詳細設定" description="互換性情報は元バージョンから引き継ぎます。変更が必要な場合だけ編集してください。">
      <div className="versionCreateAdvanced">
        <Button type="button" variant="secondary" aria-expanded={advancedOpen} aria-controls="new-version-compatibility"
          onClick={() => setAdvancedOpen(!advancedOpen)}>
          互換性情報（JSON）を{advancedOpen ? "閉じる" : "編集"}
        </Button>
        {validation.compatibilityError && <span className="formError" role="status">JSON要修正</span>}
        {advancedOpen && <div id="new-version-compatibility" className="formGroup">
          <label className="versionCreateFieldLabel" htmlFor="new-version-compatibility-input">互換性情報（JSONオブジェクト）</label>
          <textarea id="new-version-compatibility-input" rows={8} className="formControl versionCreateJsonInput"
            value={compatibility} disabled={!writable || loading}
            aria-invalid={Boolean(validation.compatibilityError)}
            onChange={(event) => setCompatibility(event.target.value)}/>
          {validation.compatibilityError && <p role="alert" className="formError">{validation.compatibilityError}</p>}
          <div className="inlineActions">
            <Button type="button" variant="secondary" disabled={!writable || loading}
              onClick={formatCompatibility}>JSONを整形</Button>
          </div>
        </div>}
      </div>
    </PageSection>

    <PageSection title="作成前の確認" description="作成すると新しいバージョンが「提案中」として登録されます。">
      {sourceVersion && replaceSource && <div className="noticeBanner warning versionCreateBanner">
        修正版を作成すると、元の提案 v{sourceVersion.number} は「取下げ」になり、新しい版が「提案中」になります。現行版はこの操作では切り替わりません。該当する関連Driftの提案先も新しい版へ更新されます。
      </div>}
      {sourceVersion && !replaceSource && <p className="formNote">元バージョンの本文・根拠・互換性情報を引き継いで新しい版を提案します。元バージョンの状態と現行版は変更しません。</p>}
      {serverError && <div role="alert" className="noticeBanner danger versionCreateBanner">
        <div>
          <strong>作成できませんでした</strong>
          <p>{serverError.message}</p>
          {serverError.sourceChanged && sourceHref && <Link href={sourceHref}
            onClick={(event) => { if (!confirmNavigation()) event.preventDefault(); }}>
            元バージョンを確認する
          </Link>}
        </div>
      </div>}
      <div className="formActions versionCreateActions">
        <Button type="button" variant="secondary" disabled={loading} onClick={goBack}>キャンセル</Button>
        <Button type="button" loading={loading} disabled={!writable || loading || Boolean(validation.sourceError)}
          onClick={() => void submit()}>
          {sourceVersion ? "修正版を作成" : "Versionを作成"}
        </Button>
      </div>
      {(!content.trim() || !rationale.trim()) && <p className="formNote">
        ルール本文と今回の変更理由は必須です。
      </p>}
    </PageSection>
  </div>;
}
