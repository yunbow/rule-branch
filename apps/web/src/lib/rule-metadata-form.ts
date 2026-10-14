export type RuleMetadataValues = {
  title: string;
  tags: string[];
  selector: {
    languages: string[];
    frameworks: string[];
    directoryGlobs: string[];
    dependencies: string[];
    repositoryIds: string[];
  };
  watchDependencies: string[];
  ownerUserId: string;
};

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

export function ruleMetadataValues(rule: Record<string, unknown>): RuleMetadataValues {
  const selector = rule.selector as Record<string, unknown> | undefined;
  const maintenance = rule.maintenance as Record<string, unknown> | undefined;
  return {
    title: String(rule.title ?? ""),
    tags: strings(rule.tags),
    selector: {
      languages: strings(selector?.languages),
      frameworks: strings(selector?.frameworks),
      directoryGlobs: strings(selector?.directoryGlobs),
      dependencies: strings(selector?.dependencies),
      repositoryIds: strings(selector?.repositoryIds),
    },
    watchDependencies: strings(maintenance?.watchDependencies),
    ownerUserId: typeof rule.ownerUserId === "string" ? rule.ownerUserId : "",
  };
}

export type RuleMetadataField = "title" | "tags" | "repositoryIds" | "languages" | "frameworks" | "directoryGlobs" | "dependencies" | "watchDependencies";
export type RuleMetadataFieldErrors = Partial<Record<RuleMetadataField, string>>;

export const SCOPE_FIELD_LABELS = {
  repositoryIds: "対象リポジトリ",
  languages: "対象言語",
  frameworks: "対象フレームワーク",
  directoryGlobs: "対象ディレクトリ",
  dependencies: "適用条件に使う依存関係",
} as const;

export function ruleMetadataFieldErrors(values: RuleMetadataValues, repositoryMode: string): RuleMetadataFieldErrors {
  const errors: RuleMetadataFieldErrors = {};
  if (!values.title.trim()) errors.title = "タイトルを入力してください。";
  else if (values.title.length > 160) errors.title = "タイトルは160文字以内で入力してください。";
  if (values.tags.length > 20) errors.tags = "タグは20件以内で指定してください。";
  if (repositoryMode === "specific" && !values.selector.repositoryIds.length) {
    errors.repositoryIds = "対象リポジトリを1件以上選択してください。";
  }
  const limits: Array<{ field: keyof RuleMetadataValues["selector"]; maximum: number }> = [
    { field: "languages", maximum: 20 },
    { field: "frameworks", maximum: 20 },
    { field: "directoryGlobs", maximum: 50 },
    { field: "dependencies", maximum: 50 },
    { field: "repositoryIds", maximum: 50 },
  ];
  for (const { field, maximum } of limits) {
    if (values.selector[field].length > maximum) {
      errors[field] = SCOPE_FIELD_LABELS[field] + "は" + maximum + "件以内で指定してください。";
    }
  }
  if (values.watchDependencies.length > 50) errors.watchDependencies = "変更を監視する依存関係は50件以内で指定してください。";
  return errors;
}

export function ruleMetadataError(values: RuleMetadataValues, repositoryMode: string): string | null {
  return Object.values(ruleMetadataFieldErrors(values, repositoryMode))[0] ?? null;
}

export type RuleMetadataChange = {
  key: string;
  label: string;
  before: string;
  after: string;
  scope: boolean;
  restrictionRemoved: boolean;
};

const listEqual = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const formatList = (items: string[], empty: string) => items.length ? items.join(", ") : empty;

export function ruleMetadataScopeSummary(
  values: RuleMetadataValues,
  repositoryMode: string,
  repositories: { id: string; fullName: string }[],
): Array<{ key: keyof RuleMetadataValues["selector"]; label: string; value: string }> {
  const names = new Map(repositories.map((repository) => [repository.id, repository.fullName]));
  return (Object.keys(SCOPE_FIELD_LABELS) as Array<keyof RuleMetadataValues["selector"]>).map((key) => {
    const selected = values.selector[key];
    const value = key === "repositoryIds"
      ? repositoryMode === "all" ? "このプロジェクトの全リポジトリ" : formatList(selected.map((id) => names.get(id) ?? id), "リポジトリ未選択")
      : formatList(selected, "制限なし（未指定）");
    return { key, label: SCOPE_FIELD_LABELS[key], value };
  });
}

export function ruleMetadataChanges(
  initial: RuleMetadataValues,
  values: RuleMetadataValues,
  initialRepositoryMode: string,
  repositoryMode: string,
  repositories: { id: string; fullName: string }[],
): RuleMetadataChange[] {
  const changes: RuleMetadataChange[] = [];
  const add = (key: string, label: string, before: string, after: string, scope = false, restrictionRemoved = false) => {
    if (before !== after) changes.push({ key, label, before, after, scope, restrictionRemoved });
  };
  add("title", "タイトル", initial.title, values.title);
  if (!listEqual(initial.tags, values.tags)) {
    add("tags", "タグ", formatList(initial.tags, "未設定"), formatList(values.tags, "未設定"));
  }
  const oldScope = ruleMetadataScopeSummary(initial, initialRepositoryMode, repositories);
  const newScope = ruleMetadataScopeSummary(values, repositoryMode, repositories);
  for (let index = 0; index < oldScope.length; index += 1) {
    const oldField = oldScope[index]!;
    const newField = newScope[index]!;
    const oldValues = initial.selector[oldField.key];
    const newValues = values.selector[oldField.key];
    if (oldField.key === "repositoryIds") {
      if (initialRepositoryMode !== repositoryMode || !listEqual(oldValues, newValues)) {
        changes.push({
          key: "repositoryIds", label: oldField.label, before: oldField.value, after: newField.value,
          scope: true, restrictionRemoved: initialRepositoryMode === "specific" && repositoryMode === "all",
        });
      }
    } else if (!listEqual(oldValues, newValues)) {
      changes.push({
        key: oldField.key, label: oldField.label, before: oldField.value, after: newField.value,
        scope: true, restrictionRemoved: oldValues.length > 0 && newValues.length === 0,
      });
    }
  }
  if (!listEqual(initial.watchDependencies, values.watchDependencies)) {
    add("watchDependencies", "変更を監視する依存関係",
      formatList(initial.watchDependencies, "未設定"), formatList(values.watchDependencies, "未設定"));
  }
  add("ownerUserId", "担当者", initial.ownerUserId || "未設定", values.ownerUserId || "未設定");
  return changes;
}

export function ruleMetadataPatch(values: RuleMetadataValues) {
  return {
    title: values.title.trim(), tags: values.tags, selector: values.selector,
    maintenance: { watchDependencies: values.watchDependencies },
    ownerUserId: values.ownerUserId || null,
  };
}
