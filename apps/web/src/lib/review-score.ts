/** A missing evaluator result is not a zero score. */
export function toReviewScore(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
}
