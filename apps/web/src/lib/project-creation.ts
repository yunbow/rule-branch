import { addTagValue } from "./tag-input.ts";

/** Keep client-side project IDs aligned with ProjectRepositoryService.SLUG. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function normalizeProjectSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/g, "")
    .slice(0, 100)
    .replace(/[-._]+$/g, "");
}

/** Names in Japanese use the selected GitHub repository as a stable fallback. */
export function suggestProjectSlug(name: string, repositories: string[] = []): string {
  const fromName = normalizeProjectSlug(name);
  if (fromName) return fromName;
  for (const repo of repositories) {
    const fromRepo = normalizeProjectSlug(repo.split("/").at(-1) ?? "");
    if (fromRepo) return fromRepo;
  }
  return "";
}

export function validateProjectSlug(slug: string): string | null {
  if (!slug) return "スラッグを生成できませんでした。リポジトリを選ぶか、英数字で入力してください。";
  if (!PROJECT_SLUG_PATTERN.test(slug)) return "先頭は英数字、全体は英小文字・数字・ピリオド・ハイフン・アンダースコアの100文字以内にしてください。";
  return null;
}

export function addProjectTag(current: string[], raw: string, limit: number): string[] {
  return addTagValue(current, raw, { maxItems: limit });
}
