"use client";

import Link from "next/link";
import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import {
  ruleMetadataChanges,
  ruleMetadataFieldErrors,
  ruleMetadataPatch,
  ruleMetadataScopeSummary,
  ruleMetadataValues,
  type RuleMetadataField,
  type RuleMetadataFieldErrors,
  type RuleMetadataValues,
} from "../../lib/rule-metadata-form.ts";
import { Button, ErrorBanner, Select, TagInput, TextField, useToast } from "../ui/index.tsx";
import { PageSection } from "../ui/Page.tsx";
import { SelectorFields, type RepositorySelectionMode } from "./SelectorFields.tsx";
import "./rule-meta-edit-form.css";

type Member = { userId: string; displayName?: string; login?: string };
export type RuleMetaEditHandle = { cancel: () => void };

const FIELD_SELECTORS: Partial<Record<RuleMetadataField, string>> = {
  title: "#rule-meta-title",
  tags: '[aria-label="分類タグを入力"]',
  repositoryIds: 'input[name="rule-repository-mode"][value="specific"]',
  languages: '[aria-label="対象言語を入力"]',
  frameworks: '[aria-label="対象フレームワークを入力"]',
  directoryGlobs: '[aria-label="対象ディレクトリを入力"]',
  dependencies: '[aria-label="適用条件に使う依存関係を入力"]',
  watchDependencies: '[aria-label="変更を監視する依存関係を入力"]',
};

export function RuleMetaEditForm({
  workspaceId, rule, repositories, writable, backHref, onCancel, onSaved, cancelRef,
}: {
  workspaceId: string;
  rule: Record<string, unknown>;
  repositories: { id: string; fullName: string; status?: string }[];
  writable: boolean;
  backHref?: string;
  onCancel?: () => void;
  onSaved?: () => void;
  cancelRef?: Ref<RuleMetaEditHandle>;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const sendingRef = useRef(false);
  const initial = ruleMetadataValues(rule);
  const initialRepositoryMode: RepositorySelectionMode = initial.selector.repositoryIds.length ? "specific" : "all";
  const [values, setValues] = useState(() => ruleMetadataValues(rule));
  const [repositoryMode, setRepositoryMode] = useState<RepositorySelectionMode>(initialRepositoryMode);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [membersError, setMembersError] = useState(false);
  const [membersLoading, setMembersLoading] = useState(true);
  const [memberRefresh, setMemberRefresh] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const changeRows = ruleMetadataChanges(initial, values, initialRepositoryMode, repositoryMode, repositories);
  const scopeRows = ruleMetadataScopeSummary(values, repositoryMode, repositories);
  const potentialExpansion = changeRows.some((change) => change.restrictionRemoved);
  const hasPendingTag = Object.values(tagDrafts).some((draft) => Boolean(draft.trim()));
  const hasChanges = changeRows.length > 0 || hasPendingTag;
  const fieldErrors = ruleMetadataFieldErrors(values, repositoryMode);
  const visibleErrors: RuleMetadataFieldErrors = attempted ? fieldErrors : {};
  const displayChangeValue = (key: string, value: string) => {
    if (key !== "ownerUserId" || value === "未設定") return value;
    const person = members.find((member) => member.userId === value);
    return person?.displayName ?? person?.login ?? value;
  };
  const pendingTag = () => Array.from(formRef.current?.querySelectorAll<HTMLInputElement>(".tagInput input") ?? [])
    .find((input) => input.value.trim());

  const updateValues = (next: RuleMetadataValues) => {
    setValues(next);
    setFormError(null);
    setError(null);
  };
  const updateTagDraft = (key: string, text: string) => {
    setTagDrafts((current) => {
      const next = { ...current };
      if (text.trim()) next[key] = text;
      else delete next[key];
      return next;
    });
    setFormError(null);
  };

  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(false);
    apiFetch<{ members: Member[] }>("/api/workspaces/" + workspaceId + "/members", { workspaceId })
      .then((result) => { if (!cancelled) setMembers(result.members); })
      .catch(() => { if (!cancelled) setMembersError(true); })
      .finally(() => { if (!cancelled) setMembersLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, memberRefresh]);

  useEffect(() => {
    if (!hasChanges) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [hasChanges]);

  const cancel = () => {
    if (loading || (hasChanges && !window.confirm("未保存の変更を破棄して移動しますか？"))) return;
    if (onCancel) onCancel();
    else if (backHref) router.push(backHref);
  };

  useImperativeHandle(cancelRef, () => ({ cancel }));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!writable || sendingRef.current || !hasChanges) return;
    setAttempted(true);
    setError(null);
    const pending = pendingTag();
    if (pending) {
      setFormError("未確定の入力があります。各入力欄の「追加」またはEnterで登録してから保存してください。");
      pending.focus();
      return;
    }
    const firstError = Object.entries(fieldErrors)[0] as [RuleMetadataField, string] | undefined;
    if (firstError) {
      setFormError("入力内容に誤りがあります。赤字で表示された項目を確認してください。");
      const selector = FIELD_SELECTORS[firstError[0]];
      if (selector) formRef.current?.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    setFormError(null);
    sendingRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/api/rules/" + String(rule.id), {
        method: "PATCH",
        workspaceId,
        body: ruleMetadataPatch(values),
      });
      toast.add("ルールの設定を保存しました");
      if (onSaved) onSaved();
      else if (backHref) { router.push(backHref); router.refresh(); }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    } finally {
      sendingRef.current = false;
      setLoading(false);
    }
  };

  return <form ref={formRef} className="sectionStack ruleMetaEditForm" noValidate onSubmit={(event) => void save(event)}>
    <div className="ruleMetaEditIntro">
      <strong>ルール設定の変更</strong>
      <p>この画面では、基本情報・適用条件・変更監視の設定を直接更新します。ルール本文は変更されず、新しいバージョンも作成されません。</p>
      {backHref && <span>本文の変更は<Link href={backHref}
        onClick={(event) => {
          if (loading || (hasChanges && !window.confirm("未保存の変更を破棄して移動しますか？"))) event.preventDefault();
        }}>ルール詳細</Link>から行ってください。</span>}
    </div>
    {!writable && <div className="noticeBanner warning ruleMetaEditWarning" role="status">このWorkspaceでルール情報を編集する権限がありません。</div>}

    <PageSection title="基本情報" description="ルールの名称と検索・整理に使用する分類です。">
      <fieldset className="ruleMetaEditFields" disabled={!writable || loading}>
        <div className="ruleMetaEditBasic">
          <div className="formGroup">
            <TextField id="rule-meta-title" label="タイトル（必須）" value={values.title}
              maxLength={160} aria-invalid={Boolean(visibleErrors.title)}
              onChange={(event) => updateValues({ ...values, title: event.target.value })}/>
            <small className="formHint">{values.title.length} / 160文字</small>
            {visibleErrors.title && <p className="formError" role="alert">{visibleErrors.title}</p>}
          </div>
          <div className="formGroup">
            <span>タグ（{values.tags.length} / 20件）</span>
            <TagInput value={values.tags} onChange={(tags) => updateValues({ ...values, tags })}
              inputLabel="分類タグを入力" placeholder="例：security" maxItems={20} showAddButton onDraftChange={(draft) => updateTagDraft("tags", draft)}/>
            <small className="formHint">ルールを探しやすくするための分類です。適用条件には影響しません。</small>
            {visibleErrors.tags && <p className="formError" role="alert">{visibleErrors.tags}</p>}
          </div>
        </div>
      </fieldset>
    </PageSection>

    <PageSection title="適用条件" description="どのリポジトリ・言語・ディレクトリなどに、このルールを適用するかを指定します。">
      <fieldset className="ruleMetaEditFields" disabled={!writable || loading}>
        <SelectorFields value={values.selector}
          onChange={(selector) => updateValues({ ...values, selector })}
          repositories={rule.scopeType === "project" ? repositories : undefined}
          repositoryMode={repositoryMode}
          onRepositoryModeChange={(mode) => { setRepositoryMode(mode); setFormError(null); }}
          onTagDraftChange={(key, draft) => updateTagDraft(key, draft)}
          showTagAddButton
          errors={visibleErrors}/>
      </fieldset>
      <div className="ruleMetaScopeSummary">
        <h3>設定中の適用条件</h3>
        <p>これは入力条件の要約です。実際に一致するコードやファイル数を解析した結果ではありません。</p>
        <dl>
          {scopeRows.map((item) => <div key={item.key}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>)}
        </dl>
      </div>
    </PageSection>

    <PageSection title="変更監視・担当" description="ルールの見直しに使う監視対象と担当者を設定します。">
      <fieldset className="ruleMetaEditFields" disabled={!writable || loading}>
        <div className="ruleMetaEditMonitoring">
          <div className="formGroup">
            <span>変更を監視する依存関係（{values.watchDependencies.length} / 50件）</span>
            <TagInput value={values.watchDependencies}
              onChange={(watchDependencies) => updateValues({ ...values, watchDependencies })}
              inputLabel="変更を監視する依存関係を入力" placeholder="例：react" maxItems={50} showAddButton
              onDraftChange={(draft) => updateTagDraft("watchDependencies", draft)}/>
            <small className="formHint">適用条件とは別の設定です。ルールの見直し対象となる依存関係を指定します。</small>
            {visibleErrors.watchDependencies && <p className="formError" role="alert">{visibleErrors.watchDependencies}</p>}
          </div>
          <div className="formGroup">
            <Select label="担当者" value={values.ownerUserId}
              onChange={(event) => updateValues({ ...values, ownerUserId: event.target.value })}>
              <option value="">未設定</option>
              {values.ownerUserId && !members.some((member) => member.userId === values.ownerUserId) &&
                <option value={values.ownerUserId}>{values.ownerUserId}（現在の担当者）</option>}
              {members.map((member) => <option key={member.userId} value={member.userId}>
                {member.displayName ?? member.login ?? member.userId}
              </option>)}
            </Select>
            {membersLoading && <small className="formHint" role="status">担当者を読み込み中…</small>}
            {membersError && <div className="ruleMetaMemberRetry">
              <small className="formHint" role="status">担当者一覧を取得できませんでした。現在の担当者は保持されます。</small>
              <Button type="button" variant="secondary" disabled={loading}
                onClick={() => setMemberRefresh((count) => count + 1)}>再取得</Button>
            </div>}
          </div>
        </div>
      </fieldset>
    </PageSection>

    <PageSection title="保存前の確認" description="ここでの保存はルール設定を直接更新します。本文のバージョン承認とは別です。">
      <div className="ruleMetaEditReviewState" aria-live="polite">
        <span className={hasChanges ? "ruleMetaUnsaved" : "ruleMetaUnchanged"}>
          {hasChanges ? "未保存の変更あり" : "変更なし"}
        </span>
        {hasPendingTag && <span className="ruleMetaDraftWarning">未確定のタグ入力があります。「追加」またはEnterで確定してください。</span>}
      </div>

      {changeRows.length > 0 ? <div className="ruleMetaChanges">
        <h3>変更内容（{changeRows.length}項目）</h3>
        <div className="tableWrap ruleMetaChangesTable">
          <table>
            <thead><tr><th scope="col">項目</th><th scope="col">変更前</th><th scope="col">変更後</th></tr></thead>
            <tbody>{changeRows.map((change) => <tr key={change.key}>
              <th scope="row">{change.label}</th>
              <td>{displayChangeValue(change.key, change.before)}</td>
              <td>{displayChangeValue(change.key, change.after)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div> : <p className="formNote">まだ変更はありません。</p>}
      {potentialExpansion && <div className="noticeBanner warning ruleMetaEditWarning">
        適用条件の制限を外す変更が含まれます。ルールの適用範囲が広がる可能性があります。保存前に変更内容を確認してください。
      </div>}
      {formError && <p className="formError" role="alert">{formError}</p>}
      {error && <ErrorBanner code={error}/>}
      <div className="formActions ruleMetaEditActions">
        <Button type="button" variant="secondary" disabled={loading} onClick={cancel}>キャンセル</Button>
        <Button type="submit" loading={loading} disabled={!writable || loading || !hasChanges}>変更を保存</Button>
      </div>
    </PageSection>
  </form>;
}
