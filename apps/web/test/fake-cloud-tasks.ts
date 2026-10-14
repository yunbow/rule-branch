import type { CloudTaskRequest, CloudTasksClientLike } from "../src/shared/analysis-jobs.ts";
/** Test-only minimal Cloud Tasks fake. */
export class FakeCloudTasksClient implements CloudTasksClientLike { readonly tasks: CloudTaskRequest[] = []; async createTask({ task }: { parent: string; task: CloudTaskRequest }): Promise<void> { if (this.tasks.some((item) => item.name === task.name)) { const error = Object.assign(new Error("ALREADY_EXISTS"), { code: "ALREADY_EXISTS" }); throw error; } this.tasks.push(structuredClone(task)); } }
