"use client";

import { useState } from "react";
import { Checkbox, TagInput } from "../ui/index.tsx";

export type SelectorValue = {
  languages: string[];
  frameworks: string[];
  directoryGlobs: string[];
  dependencies: string[];
  repositoryIds: string[];
};
export type RepositorySelectionMode = "all" | "specific";
export type SelectorDraftField = "languages" | "frameworks" | "directoryGlobs" | "dependencies";

export const emptySelector = (): SelectorValue => ({
  languages: [], frameworks: [], directoryGlobs: [], dependencies: [], repositoryIds: [],
});

const TAG_FIELDS: Array<{ key: SelectorDraftField; label: string; hint: string; placeholder: string }> = [
  { key: "languages", label: "対象言語", hint: "例：TypeScript、Kotlin", placeholder: "例：TypeScript" },
  { key: "frameworks", label: "対象フレームワーク", hint: "例：Next.js、Spring", placeholder: "例：Next.js" },
  { key: "directoryGlobs", label: "対象ディレクトリ", hint: "例：src/**、apps/web/**。パターンを指定します。", placeholder: "例：apps/web/**" },
  { key: "dependencies", label: "適用条件に使う依存関係", hint: "例：react、ktor。この条件でルールの適用対象を絞り込みます。", placeholder: "例：react" },
];

export function SelectorFields({
  value,
  onChange,
  repositories,
  repositoryMode,
  onRepositoryModeChange,
  onTagDraftChange,
  showTagAddButton = false,
  errors,
}: {
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  repositories?: { id: string; fullName: string; status?: string }[];
  repositoryMode?: RepositorySelectionMode;
  onRepositoryModeChange?: (mode: RepositorySelectionMode) => void;
  onTagDraftChange?: (key: SelectorDraftField, draft: string) => void;
  showTagAddButton?: boolean;
  errors?: Partial<Record<keyof SelectorValue, string>>;
}) {
  const [localMode, setLocalMode] = useState<RepositorySelectionMode>(value.repositoryIds.length ? "specific" : "all");
  const mode = repositoryMode ?? localMode;
  const set = (key: keyof SelectorValue, next: string[]) => onChange({ ...value, [key]: next });
  const setMode = (next: RepositorySelectionMode) => {
    setLocalMode(next);
    onRepositoryModeChange?.(next);
    if (next === "all") set("repositoryIds", []);
  };

  return <fieldset className="formGroup selectorFields">
    <legend>絞り込み条件</legend>
    <p className="formNote">未指定の条件では制限しません。必要な条件だけ追加してください。</p>
    {repositories && <div className="ruleRepoScope">
      <span className="ruleRepoScopeTitle">対象リポジトリ</span>
      <div className="ruleRepoScopeOptions" role="group" aria-label="リポジトリへの適用範囲">
        <label><input type="radio" name="rule-repository-mode" value="all"
          checked={mode === "all"} onChange={() => setMode("all")}/>このプロジェクトの全リポジトリ</label>
        <label><input type="radio" name="rule-repository-mode" value="specific"
          checked={mode === "specific"} onChange={() => setMode("specific")}/>リポジトリを指定</label>
      </div>
      <p className="formNote">リポジトリの選択に加え、下の言語・ディレクトリ等の条件も適用されます。</p>
      {mode === "specific" && <>
        <div className="repositoryChecklist">
          {repositories.filter((repository) => !repository.status || repository.status === "active" || value.repositoryIds.includes(repository.id)).map((repository) =>
            <Checkbox key={repository.id} label={repository.fullName + (repository.status && repository.status !== "active" ? "（連携解除済み・選択を外してください）" : "")}
              checked={value.repositoryIds.includes(repository.id)}
              onChange={(event) => set("repositoryIds", event.target.checked && (!repository.status || repository.status === "active")
                ? [...value.repositoryIds, repository.id]
                : value.repositoryIds.filter((id) => id !== repository.id))}/>)}
        </div>
        {value.repositoryIds.length === 0 &&
          <p className="formHint">1件以上選択してください。選択がない状態では保存できません。</p>}
      </>}
      <p className="ruleScopePreview" aria-live="polite">
        選択中：{mode === "all" ? "このプロジェクトの全リポジトリ" :
          value.repositoryIds.length > 0 ? value.repositoryIds.length + "件のリポジトリ" : "リポジトリ未選択"}
      </p>
      {errors?.repositoryIds && <p className="formError" role="alert">{errors.repositoryIds}</p>}
    </div>}
    <div className="formGrid">
      {TAG_FIELDS.map((field) =>
        <div className="formGroup" key={field.key}>
          <span>{field.label}</span>
          <TagInput value={value[field.key]} onChange={(next) => set(field.key, next)}
            inputLabel={field.label + "を入力"} placeholder={field.placeholder}
            maxItems={field.key === "languages" || field.key === "frameworks" ? 20 : 50}
            caseSensitive={field.key === "directoryGlobs"} showAddButton={showTagAddButton}
            onDraftChange={(draft) => onTagDraftChange?.(field.key, draft)}/>
          <small className="formHint">{field.hint}　{value[field.key].length}件</small>
          {errors?.[field.key] && <p className="formError" role="alert">{errors[field.key]}</p>}
        </div>)}
    </div>
  </fieldset>;
}
