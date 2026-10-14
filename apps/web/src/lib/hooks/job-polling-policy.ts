export const isActiveJobStatus = (status: string | null | undefined): boolean => status === "queued" || status === "running";
/** Pure polling policy, intentionally independent of React and browser globals. */
export const shouldPollJob = (status: string | null | undefined, documentHidden: boolean, enabled = true): boolean => enabled && isActiveJobStatus(status) && !documentHidden;

type JobStatus = { id: string; status: string };

/** A project list needs one polling loop regardless of how many active rows it contains. */
export const shouldPollProjectJobs = (jobs: readonly JobStatus[], documentHidden: boolean, excludedJobId?: string): boolean =>
  !documentHidden && jobs.some((job) => job.id !== excludedJobId && isActiveJobStatus(job.status));

/** Keep the server's newest-first order while retaining any client-only fields. */
export function mergeProjectJobs<T extends JobStatus>(current: readonly T[], incoming: readonly T[]): T[] {
  const currentById = new Map(current.map((job) => [job.id, job]));
  return incoming.map((job) => ({ ...currentById.get(job.id), ...job }));
}
