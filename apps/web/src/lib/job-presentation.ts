export type JobDatePrecision = "short" | "medium";

export function formatJobDate(value: string | null | undefined, precision: JobDatePrecision): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: precision,
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

export function elapsedJobSeconds(value: string | null | undefined, now: number | null): number | null {
  if (!value || now === null) return null;
  const startedAt = Date.parse(value);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
