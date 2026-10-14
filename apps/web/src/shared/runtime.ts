import type { AuthService } from "./auth.ts";
import type { UserPreferencesService } from "./user-preferences.ts";
import type { GitHubAppService } from "./github-app.ts";
import type { WorkspaceInvitationsService } from "./workspace-invitations.ts";
import type { ProjectRepositoryService } from "./project-repositories.ts";
import type { RulesService } from "./rules.ts";
import type { DriftService } from "./drift.ts";
import type { AnalysisJob, FirestoreRuleStore } from "./rulestore.ts";
import type { OidcVerifier } from "./purge-api.ts";
import type { AutomaticApprovalService } from "./automatic-approval.ts";
/** Composition root set by the deployed server bootstrap; tests use handler factories directly. */
export type Runtime = { auth: AuthService; preferences: UserPreferencesService; sessionSecret: string; githubApp?: GitHubAppService; githubWebhookSecret?: string; workspaceInvitations?: WorkspaceInvitationsService; projectRepositories?: ProjectRepositoryService; rules?: RulesService; drift?: DriftService; store?: FirestoreRuleStore; redispatchAnalysisJob?: (job: AnalysisJob) => Promise<void>; schedulerOidcVerifier?: OidcVerifier; schedulerAudience?: string; automaticApproval?: AutomaticApprovalService; };
// Instrumentation and route handlers are emitted into separate Turbopack bundles.
// Module-local state is therefore not shared between them; use the process-global
// object so one Cloud Run instance observes the runtime composed at startup.
const runtimeGlobal = globalThis as typeof globalThis & { __rulebranchRuntime?: Runtime };
export function configureRuntime(value: Runtime): void { runtimeGlobal.__rulebranchRuntime = value; }
export function getRuntime(): Runtime { const services = runtimeGlobal.__rulebranchRuntime; if (!services) throw new Error("RuleBranch runtime is not configured"); return services; }
