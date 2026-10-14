import { LIMITS } from "./contracts.ts";

export interface AppConfig {
  deployment: { mode: "cloud-saas" };
  ai: { provider: "gemini-api" | "vertex-ai"; model: { fast: string; reasoning: string } };
  limits: typeof LIMITS;
}
export interface GitHubAppConfig { appId: string; privateKey: string; webhookSecret: string; }
/** Secrets are injected by deployment configuration; no secret is persisted by this module. */
export function loadGitHubAppConfig(env: Record<string, string | undefined> = process.env): GitHubAppConfig {
  const appId = env.RULEBRANCH_GITHUB_APP_ID, privateKey = env.RULEBRANCH_GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"), webhookSecret = env.RULEBRANCH_GITHUB_WEBHOOK_SECRET;
  if (!appId || !privateKey || !webhookSecret) throw new Error("GitHub App ID, private key, and webhook secret must be configured"); return { appId, privateKey, webhookSecret };
}
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.RULEBRANCH_DEPLOYMENT_MODE ?? "cloud-saas";
  if (mode !== "cloud-saas") throw new Error(`Unsupported deployment.mode: ${mode}`);
  const provider = env.RULEBRANCH_AI_PROVIDER;
  if (provider !== "gemini-api" && provider !== "vertex-ai") throw new Error("ai.provider must be gemini-api or vertex-ai");
  const fast = env.RULEBRANCH_AI_MODEL_FAST;
  const reasoning = env.RULEBRANCH_AI_MODEL_REASONING;
  if (!fast || !reasoning) throw new Error("ai.model.fast and ai.model.reasoning must be configured");
  return { deployment: { mode }, ai: { provider, model: { fast, reasoning } }, limits: LIMITS };
}
