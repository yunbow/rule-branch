import { enqueueAnalysisJob, type CloudTasksClientLike } from "./analysis-jobs.ts";
import { log } from "./logger.ts";
import { FirestoreRuleStore, type AnalysisJob, type CreateAnalysisJobInput, type RuleStoreContext } from "./rulestore.ts";

export type AnalysisTaskConfig = { client: CloudTasksClientLike; parent: string; taskUrl: string; audience: string; serviceAccountEmail: string };

/** Store decorator which makes every queued job visible to Cloud Tasks. */
export class EnqueueingRuleStore extends FirestoreRuleStore {
  private readonly taskConfig: AnalysisTaskConfig;
  constructor(firestore: ConstructorParameters<typeof FirestoreRuleStore>[0], taskConfig: AnalysisTaskConfig) { super(firestore); this.taskConfig = taskConfig; }
  override async createAnalysisJob(ctx: RuleStoreContext, input: CreateAnalysisJobInput) {
    const result = await super.createAnalysisJob(ctx, input);
    if (result.job.status === "queued") await this.redispatch(result.job);
    return result;
  }
  /** Re-attempts the Cloud Tasks dispatch for a job that already exists and is still
   * "queued" (the analysis_jobs write already committed; only the Cloud Tasks side needs
   * retrying). The task name is derived from job.id, so this is safe to call repeatedly:
   * a still-outstanding task collides (ALREADY_EXISTS, swallowed) rather than duplicating. */
  async redispatch(job: AnalysisJob): Promise<void> {
    try { await enqueueAnalysisJob(this.taskConfig.client, this.taskConfig.parent, this.taskConfig.taskUrl, this.taskConfig.audience, this.taskConfig.serviceAccountEmail, job); }
    catch (error) {
      log("ERROR", "analysis job enqueue failed", { jobId: job.id, type: job.type, error: String(error) });
      throw error;
    }
  }
}
