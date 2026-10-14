export type SeedDocument = readonly [collection: string, id: string, data: Record<string, unknown>];
export type DemoStage = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function parseSeedStage(args: readonly string[]): DemoStage | undefined {
  const values = args.filter((arg) => arg.startsWith("--stage="));
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^--stage=[1-7]$/.test(values[0])) throw new Error("--stage must be an integer from 1 to 7");
  return Number(values[0].slice("--stage=".length)) as DemoStage;
}

/** Classifies each existing demo fixture by the first demo step that needs it. */
export function stageForSeedDocument([collection, id]: SeedDocument): DemoStage {
  if (collection === "resolution_snapshots" || collection === "revision_prs" || collection === "compiled_artifacts" || id === "seed-projects-3" || id === "seed-repositories-2" || id === "seed-repositories-3") return 7;
  if (id.startsWith("seed-ui006-") || ["seed-rules-2", "seed-rules-3", "seed-rules-4", "seed-rules-5", "seed-rule_versions-4", "seed-rule_versions-5", "seed-evidence-2", "seed-evidence-3", "seed-evidence-4"].includes(id)) return 6;
  if (["seed-drift_findings-5", "seed-rule_versions-1", "seed-evidence-7", "seed-evidence-8", "seed-analysis_jobs-7"].includes(id)) return 5;
  // Keep the accepted-only fixture separate from the stage-5 proposal and its evidence.
  if (["seed-drift_findings-accepted", "seed-evidence-accepted-package", "seed-evidence-accepted-readme"].includes(id)) return 4;
  if (collection === "change_triggers" || id.startsWith("seed-drift_findings-") || ["seed-rules-13", "seed-rules-14", "seed-rules-15", "seed-rules-16", "seed-evidence-1", "seed-evidence-5", "seed-evidence-6"].includes(id)) return 3;
  if (["seed-analysis_jobs-2", "seed-analysis_jobs-3", "seed-analysis_jobs-4", "seed-analysis_jobs-5"].includes(id)) return 2;
  return 1;
}

/** Stages are cumulative; omitting the option intentionally preserves the full seed. */
export function filterSeedDocuments(documents: readonly SeedDocument[], stage?: DemoStage): SeedDocument[] {
  return stage === undefined ? [...documents] : documents.filter((document) => stageForSeedDocument(document) <= stage);
}
