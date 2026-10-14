/** Compiler aggregate outputs are not tied to an individual rule. */
export function isAggregateArtifactPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return name === "AGENTS.md" || name === "CLAUDE.md" || name === "copilot-instructions.md" || name === "_denied.md";
}

export const shortSha = (value: unknown): string => typeof value === "string" && value ? value.slice(0, 8) : "—";
