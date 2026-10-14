/** Repository-wide policy inheritance cannot use a child narrower than its parent.
 * Keep this conservative: arbitrary glob inclusion is not provable. The same
 * cases are exercised in Python against relation_scope.uncovered_relation_fields.
 */
const CONTEXT_FIELDS = ["languages", "frameworks", "directoryGlobs", "dependencies"] as const;
type ContextField = (typeof CONTEXT_FIELDS)[number];

function scopeValues(selector: Record<string, unknown>, field: ContextField): Set<string> {
  const raw = selector[field] ?? [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new TypeError(`Invalid relation selector: ${field}`);
  }
  return new Set((raw as string[]).map((item) =>
    field === "languages" || field === "frameworks" ? item.toLowerCase() : item
  ));
}

/** Ignore repositoryIds: repository selection is resolved before file-level rules. */
export function uncoveredRelationFields(parent: unknown, child: unknown): string[] {
  const normalize = (selector: unknown): Record<string, unknown> => {
    if (selector == null) return {};
    if (typeof selector !== "object" || Array.isArray(selector)) throw new TypeError("Invalid relation selector");
    return selector as Record<string, unknown>;
  };
  const from = normalize(parent), to = normalize(child);
  const uncovered: string[] = [];
  for (const field of CONTEXT_FIELDS) {
    const childValues = scopeValues(to, field);
    if (!childValues.size) continue;
    const parentValues = scopeValues(from, field);
    if (parentValues.size && [...parentValues].every((value) => childValues.has(value))) continue;
    uncovered.push(field);
  }
  return uncovered;
}
