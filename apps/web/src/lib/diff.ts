export type DiffLine = { type: "unchanged" | "added" | "removed"; text: string };

/** Splits text without inventing a line for an empty document. */
export function splitLines(content: string): string[] {
  return content === "" ? [] : content.split("\n");
}
export function hasComparison(currentVersionId: string | null): boolean { return currentVersionId !== null; }

/**
 * A line-oriented longest-common-subsequence diff.  Adjacent delete/insert
 * operations represent a changed line; callers can render the two columns
 * directly without losing either side of the change.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const left = splitLines(before), right = splitLines(after);
  const lcs = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.push({ type: "unchanged", text: left[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { result.push({ type: "removed", text: left[i] }); i += 1; }
    else { result.push({ type: "added", text: right[j] }); j += 1; }
  }
  while (i < left.length) { result.push({ type: "removed", text: left[i] }); i += 1; }
  while (j < right.length) { result.push({ type: "added", text: right[j] }); j += 1; }
  return result;
}
