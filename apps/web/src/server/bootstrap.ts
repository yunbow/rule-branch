import { CloudTasksClient } from "@google-cloud/tasks";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { buildAutomaticApproval } from "./approval-bootstrap.ts";
import { AuthService, GitHubRestApiClient } from "../shared/auth.ts";
import { EnqueueingRuleStore } from "../shared/enqueueing-rulestore.ts";
import { GitHubAppAuth, GitHubAppAuthenticatedClient, GitHubAppRestClient, GitHubAppService } from "../shared/github-app.ts";
import { ProjectRepositoryService } from "../shared/project-repositories.ts";
import { GoogleOidcVerifier, rejectingOidcVerifier } from "../shared/purge-api.ts";
import { RulesService } from "../shared/rules.ts";
import { configureRuntime, type Runtime } from "../shared/runtime.ts";
import { FirestoreRuleStore } from "../shared/rulestore.ts";
import { DriftService } from "../shared/drift.ts";
import { UserPreferencesService } from "../shared/user-preferences.ts";
import { WorkspaceInvitationsService } from "../shared/workspace-invitations.ts";

export type FirestoreFactory = (opts: { projectId: string; emulatorHost?: string }) => unknown;
export type EnvLike = Record<string, string | undefined>;
const complete = (env: EnvLike, names: string[]) => names.every((name) => Boolean(env[name]));

export function buildRuntime(env: EnvLike, firestoreFactory?: FirestoreFactory): Runtime | undefined {
  const projectId = env.FIRESTORE_PROJECT_ID;
  if (!projectId || !env.RULEBRANCH_SESSION_SECRET) return undefined;
  if (env.NODE_ENV === "production" && Buffer.byteLength(env.RULEBRANCH_SESSION_SECRET, "utf8") < 32) throw new Error("RULEBRANCH_SESSION_SECRET must be at least 32 bytes in production");
  const oauthRequested = Boolean(env.GITHUB_OAUTH_CLIENT_ID || env.GITHUB_OAUTH_CLIENT_SECRET);
  if (env.NODE_ENV === "production" && env.RULEBRANCH_DEMO_LOGIN_ENABLED === "1") {
    if (!complete(env, ["RULEBRANCH_DEMO_LOGIN_ID", "RULEBRANCH_DEMO_LOGIN_PASSWORD"])) {
      throw new Error("Judge demo login ID and password must be configured when demo login is enabled");
    }
    if ((env.RULEBRANCH_DEMO_LOGIN_PASSWORD?.length ?? 0) < 12) {
      throw new Error("Judge demo login password must be at least 12 characters");
    }
  }
  if (env.NODE_ENV === "production" && oauthRequested) {
    if (!complete(env, ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"])) throw new Error("GitHub OAuth client ID and secret must be configured together");
    let publicUrl: URL;
    try { publicUrl = new URL(env.RULEBRANCH_PUBLIC_URL ?? ""); }
    catch { throw new Error("RULEBRANCH_PUBLIC_URL must be configured for production OAuth"); }
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) throw new Error("RULEBRANCH_PUBLIC_URL must be an HTTPS origin without credentials for production OAuth");
  }
  const firestore = firestoreFactory ? firestoreFactory({ projectId, emulatorHost: env.FIRESTORE_EMULATOR_HOST }) : (() => {
    if (getApps().length === 0) initializeApp({ projectId });
    return getFirestore();
  })();
  let store: FirestoreRuleStore;
  let redispatchAnalysisJob: Runtime["redispatchAnalysisJob"];
  if (complete(env, ["GOOGLE_CLOUD_PROJECT", "CLOUD_TASKS_LOCATION", "CLOUD_TASKS_QUEUE", "WORKER_URL", "WORKER_SERVICE_ACCOUNT_EMAIL"])) {
    const client = new CloudTasksClient();
    const enqueueingStore = new EnqueueingRuleStore(firestore as ConstructorParameters<typeof FirestoreRuleStore>[0], {
      client, parent: client.queuePath(env.GOOGLE_CLOUD_PROJECT!, env.CLOUD_TASKS_LOCATION!, env.CLOUD_TASKS_QUEUE!), taskUrl: new URL("/tasks/analysis-jobs", env.WORKER_URL!).toString(), audience: env.WORKER_URL!, serviceAccountEmail: env.WORKER_SERVICE_ACCOUNT_EMAIL!,
    });
    store = enqueueingStore;
    // Pass the capability across bundles; constructor identity is bundle-local.
    redispatchAnalysisJob = (job) => enqueueingStore.redispatch(job);
  } else store = new FirestoreRuleStore(firestore as ConstructorParameters<typeof FirestoreRuleStore>[0]);
  const githubRest = new GitHubRestApiClient(env.GITHUB_OAUTH_CLIENT_ID ?? "", env.GITHUB_OAUTH_CLIENT_SECRET ?? "", fetch, env.RULEBRANCH_PUBLIC_URL ? new URL("/api/auth/github/callback", env.RULEBRANCH_PUBLIC_URL).toString() : undefined);
  let githubApp: GitHubAppService | undefined; let authenticatedClient: GitHubAppAuthenticatedClient | undefined;
  if (complete(env, ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"])) {
    const restClient = new GitHubAppRestClient();
    const auth = new GitHubAppAuth({ appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_APP_PRIVATE_KEY! }, restClient);
    authenticatedClient = new GitHubAppAuthenticatedClient(restClient, auth);
    githubApp = new GitHubAppService(store, authenticatedClient);
  }
  const audience = env.SCHEDULER_OIDC_AUDIENCE, schedulerServiceAccountEmail = env.SCHEDULER_SERVICE_ACCOUNT_EMAIL;
  return { store, redispatchAnalysisJob, sessionSecret: env.RULEBRANCH_SESSION_SECRET, auth: new AuthService(store, githubRest, githubApp), preferences: new UserPreferencesService(store), githubApp, githubWebhookSecret: githubApp ? env.GITHUB_WEBHOOK_SECRET : undefined, workspaceInvitations: new WorkspaceInvitationsService(store, githubRest), projectRepositories: authenticatedClient ? new ProjectRepositoryService(store, authenticatedClient) : undefined, rules: new RulesService(store), drift: new DriftService(store), schedulerOidcVerifier: audience && schedulerServiceAccountEmail ? new GoogleOidcVerifier(schedulerServiceAccountEmail) : rejectingOidcVerifier, schedulerAudience: audience, automaticApproval: buildAutomaticApproval(firestore as Firestore, store, env) };
}

export function bootstrap(): void { const runtime = buildRuntime(process.env); if (runtime) configureRuntime(runtime); }
