import type { Firestore } from "firebase-admin/firestore";
import type { FirestoreRuleStore } from "../shared/rulestore.ts";
import { loadApprovalConfig } from "../shared/approval-policy.ts";
import { AutomaticApprovalService } from "../shared/automatic-approval.ts";
import { FirestoreApprovalRepository } from "../shared/firestore-approval-repository.ts";
import { GoogleApprovalEvaluator } from "../shared/google-approval-review.ts";

export function buildAutomaticApproval(db: Firestore, store: FirestoreRuleStore, env: Record<string, string | undefined>): AutomaticApprovalService | undefined {
  const config = loadApprovalConfig(env);
  if (config.mode === "manual" || config.workspaceIds.length === 0) return undefined;
  return new AutomaticApprovalService(new FirestoreApprovalRepository(db, store), new GoogleApprovalEvaluator(config), config);
}
