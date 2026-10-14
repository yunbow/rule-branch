import { RuleStoreError } from "./rulestore.ts";

export const JUDGE_DEMO_USER_ID = "judge-demo-user";

/** Demo sessions may read the fixed fixture, but must never reach a mutation. */
export function rejectJudgeDemoMutation(userId: string | null): void {
  if (userId === JUDGE_DEMO_USER_ID) {
    throw new RuleStoreError("DEMO_READ_ONLY", 403);
  }
}
