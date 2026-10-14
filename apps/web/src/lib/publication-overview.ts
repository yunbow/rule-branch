export type PublicationRepository = {
  id: string;
  fullName: string;
  defaultBranch?: string;
};

export type PublicationRevisionPr = {
  id: string;
  repositoryId: string;
  status: string;
  prNumber?: number | string;
  prUrl?: string;
  branch?: string;
  openedAt?: string;
  mergedAt?: string;
  createdAt?: string;
  verification?: {
    state?: string;
    checkedCommitSha?: string;
    mismatchedPaths?: string[];
  } | null;
};

export type PublicationArtifact = {
  id: string;
  repositoryId: string;
  target?: string;
  path?: string;
  generatedAt?: string;
  publishedAt?: string;
  gitBlobSha?: string;
  commitSha?: string;
  contentOmitted?: boolean;
};

export type PublicationData = {
  revisionPrs: PublicationRevisionPr[];
  compiledArtifacts: PublicationArtifact[];
};

export type PublicationFilter = "all" | "draft" | "pending" | "mismatch" | "verified" | "unrecorded";
export type PublicationSort = "attention" | "recent" | "name";
export type PublicationVerification = "none" | "pending" | "mismatch" | "verified";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const optionalPrNumber = (value: unknown): number | string | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : optionalString(value);

/**
 * Restrict hydrated and refreshed records to the fields needed by the UI.
 * In particular, compiled_artifacts.content must never enter page props.
 */
export function normalizePublicationData(
  prs: readonly unknown[],
  artifacts: readonly unknown[],
  allowedRepositoryIds: ReadonlySet<string>,
): PublicationData {
  return {
    revisionPrs: prs.flatMap((raw) => {
      const item = asRecord(raw);
      if (item.deletedAt || typeof item.repositoryId !== "string" ||
        !allowedRepositoryIds.has(item.repositoryId)) return [];
      const verification = asRecord(item.verification);
      return [{
        id: String(item.id ?? ""),
        repositoryId: item.repositoryId,
        status: String(item.status ?? ""),
        prNumber: optionalPrNumber(item.prNumber),
        prUrl: optionalString(item.prUrl),
        branch: optionalString(item.branch),
        openedAt: optionalString(item.openedAt),
        mergedAt: optionalString(item.mergedAt),
        createdAt: optionalString(item.createdAt),
        verification: item.verification == null ? null : {
          state: optionalString(verification.state),
          checkedCommitSha: optionalString(verification.checkedCommitSha),
          mismatchedPaths: Array.isArray(verification.mismatchedPaths)
            ? verification.mismatchedPaths.filter((path): path is string => typeof path === "string")
            : [],
        },
      } satisfies PublicationRevisionPr];
    }),
    compiledArtifacts: artifacts.flatMap((raw) => {
      const item = asRecord(raw);
      if (item.deletedAt || typeof item.repositoryId !== "string" ||
        !allowedRepositoryIds.has(item.repositoryId)) return [];
      return [{
        id: String(item.id ?? ""),
        repositoryId: item.repositoryId,
        target: optionalString(item.target),
        path: optionalString(item.path),
        generatedAt: optionalString(item.generatedAt),
        publishedAt: optionalString(item.publishedAt),
        gitBlobSha: optionalString(item.gitBlobSha),
        commitSha: optionalString(item.commitSha),
        contentOmitted: item.contentOmitted === true,
      } satisfies PublicationArtifact];
    }),
  };
}

const when = (value?: string): number => {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

export function formatPublicationDate(value: unknown, withTime = false): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  }).format(new Date(value));
}

function newestPr(prs: readonly PublicationRevisionPr[], field: "openedAt" | "mergedAt"): PublicationRevisionPr | undefined {
  return [...prs].sort((a, b) =>
    when(b[field] ?? b.createdAt) - when(a[field] ?? a.createdAt) ||
    b.id.localeCompare(a.id))[0];
}

export function getRepositoryPublication(
  repositoryId: string,
  data: PublicationData,
) {
  const allPrs = data.revisionPrs.filter((pr) => pr.repositoryId === repositoryId);
  const draftPrs = allPrs.filter((pr) => pr.status === "draft_open");
  const mergedPrs = allPrs.filter((pr) => pr.status === "merged");
  const latestDraft = newestPr(draftPrs, "openedAt");
  const latestMerged = newestPr(mergedPrs, "mergedAt");
  const verificationState = latestMerged?.verification?.state;
  const verification: PublicationVerification = !latestMerged ? "none"
    : verificationState === "verified" ? "verified"
    : verificationState === "mismatch" ? "mismatch"
    : "pending";
  const hasMissingVerification = Boolean(latestMerged && !verificationState);
  const artifacts = data.compiledArtifacts
    .filter((artifact) => artifact.repositoryId === repositoryId)
    .sort((a, b) => when(b.generatedAt) - when(a.generatedAt) || b.id.localeCompare(a.id));
  const latestAt = Math.max(0,
    ...allPrs.map((pr) => when(pr.mergedAt ?? pr.openedAt ?? pr.createdAt)),
    ...artifacts.map((artifact) => when(artifact.generatedAt)));
  return {
    allPrs, draftPrs, mergedPrs, latestDraft, latestMerged, verification, hasMissingVerification,
    artifacts, latestAt,
    isUnrecorded: allPrs.length === 0 && artifacts.length === 0,
    hasNoPr: allPrs.length === 0,
  };
}

export type RepositoryPublication = ReturnType<typeof getRepositoryPublication>;

export function matchesPublicationFilter(item: RepositoryPublication, filter: PublicationFilter): boolean {
  switch (filter) {
    case "draft": return item.draftPrs.length > 0;
    case "pending": return item.verification === "pending";
    case "mismatch": return item.verification === "mismatch";
    case "verified": return item.verification === "verified";
    case "unrecorded": return item.isUnrecorded;
    default: return true;
  }
}

export function publicationAttentionRank(item: RepositoryPublication): number {
  if (item.verification === "mismatch") return 0;
  if (item.draftPrs.length > 0) return 1;
  if (item.verification === "pending") return 2;
  if (item.isUnrecorded) return 3;
  if (item.hasNoPr) return 4;
  return 5;
}

export function getPublicationSummary(
  repositories: readonly PublicationRepository[],
  data: PublicationData,
) {
  const presentations = repositories.map((repository) => ({
    repository,
    publication: getRepositoryPublication(repository.id, data),
  }));
  return {
    drafts: presentations.reduce((sum, item) => sum + item.publication.draftPrs.length, 0),
    draftRepositories: presentations.filter((item) => item.publication.draftPrs.length > 0).length,
    pending: presentations.filter((item) => item.publication.verification === "pending").length,
    mismatch: presentations.filter((item) => item.publication.verification === "mismatch").length,
    verified: presentations.filter((item) => item.publication.verification === "verified").length,
    unrecorded: presentations.filter((item) => item.publication.isUnrecorded).length,
  };
}

/** Do not trust arbitrary PR URLs supplied by stored metadata. */
export function safePublicationPrUrl(value: unknown, fullName: string): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
      url.username || url.password || url.hash) return null;
    if (url.pathname !== `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${url.pathname.split("/").pop()}`) return null;
    const number = url.pathname.split("/").pop() ?? "";
    if (!/^[1-9][0-9]*$/.test(number)) return null;
    return url.toString();
  } catch { return null; }
}
