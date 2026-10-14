export type AddTagOptions = {
  maxItems?: number;
  caseSensitive?: boolean;
};

export type TagAddition = {
  value: string[];
  outcome: "added" | "empty" | "duplicate" | "limit";
};

export function resolveTagAddition(current: string[], raw: string, options: AddTagOptions = {}): TagAddition {
  const tag = raw.trim().replace(/\s+/g, " ");
  if (!tag) return { value: current, outcome: "empty" };
  const exists = current.some((item) => options.caseSensitive
    ? item === tag
    : item.toLocaleLowerCase() === tag.toLocaleLowerCase());
  if (exists) return { value: current, outcome: "duplicate" };
  if (options.maxItems !== undefined && current.length >= options.maxItems) {
    return { value: current, outcome: "limit" };
  }
  return { value: [...current, tag], outcome: "added" };
}

export function addTagValue(current: string[], raw: string, options: AddTagOptions = {}): string[] {
  return resolveTagAddition(current, raw, options).value;
}

export function removeTagValue(current: string[], tag: string): string[] {
  const next = current.filter((item) => item !== tag);
  return next.length === current.length ? current : next;
}

export function isTagCommitKey(key: string, isComposing: boolean, commitKeys: readonly string[]): boolean {
  return !isComposing && commitKeys.includes(key);
}
