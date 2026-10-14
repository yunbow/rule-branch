import { createHmac, timingSafeEqual } from "node:crypto";
import { generateUlid } from "./ulid.ts";
import { FirestoreRuleStore, isRuleStoreError, RuleStoreError, type DocumentData } from "./rulestore.ts";
import { userActor, userContext } from "./service-context.ts";

export const TRANSFER_POLICY_PROHIBITED = "prohibited" as const;
export interface GitHubUser { id: string | number; login: string; name?: string | null; email?: string | null; }
export interface GitHubApiClient { exchangeCodeForToken(code: string): Promise<string>; getAuthenticatedUser(accessToken: string): Promise<GitHubUser>; }
/** Unauthenticated public-user lookup used by workspace invitations. */
export interface GitHubUserLookupApiClient { getUserByLogin(login: string): Promise<GitHubUser | null>; }
export class GitHubRestApiClient implements GitHubApiClient, GitHubUserLookupApiClient {
  private readonly clientId: string; private readonly clientSecret: string; private readonly fetchImpl: typeof fetch; private readonly redirectUri?: string;
  constructor(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch, redirectUri?: string) { this.clientId = clientId; this.clientSecret = clientSecret; this.fetchImpl = fetchImpl; this.redirectUri = redirectUri; }
  async exchangeCodeForToken(code: string): Promise<string> {
    const payload = { client_id: this.clientId, client_secret: this.clientSecret, code, ...(this.redirectUri ? { redirect_uri: this.redirectUri } : {}) };
    const response = await this.fetchImpl("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error("GitHub OAuth token exchange failed");
    const result = await response.json() as { access_token?: string };
    if (!result.access_token) throw new Error("GitHub OAuth token missing"); return result.access_token;
  }
  async getAuthenticatedUser(accessToken: string): Promise<GitHubUser> {
    const response = await this.fetchImpl("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "User-Agent": "RuleBranch/1.0", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw new Error("GitHub user lookup failed"); return await response.json() as GitHubUser;
  }
  async getUserByLogin(login: string): Promise<GitHubUser | null> {
    const response = await this.fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "RuleBranch/1.0", "X-GitHub-Api-Version": "2022-11-28" } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("GitHub user lookup failed"); return await response.json() as GitHubUser;
  }
}
export interface Session { userId: string; issuedAt: number; }
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function signSession(session: Session, secret: string): string { const body = Buffer.from(JSON.stringify(session)).toString("base64url"); const signature = createHmac("sha256", secret).update(body).digest("base64url"); return `${body}.${signature}`; }
export function verifySession(value: string | undefined, secret: string): Session | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  // Reject non-canonical input before timingSafeEqual. Comparing JavaScript string
  // lengths is insufficient because an attacker can supply multi-byte Unicode.
  if (!body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const signatureBytes = Buffer.from(signature, "ascii");
  if (signatureBytes.length !== Buffer.byteLength(expected, "ascii") || !timingSafeEqual(Buffer.from(expected, "ascii"), signatureBytes)) return null;
  try {
    const result = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    const now = Date.now();
    return typeof result.userId === "string" && result.userId.length > 0
      && Number.isFinite(result.issuedAt) && result.issuedAt <= now
      && now - result.issuedAt <= SESSION_MAX_AGE_MS ? result : null;
  } catch { return null; }
}

export interface LoggedInUser extends DocumentData { id: string; personalWorkspaceId: string; }
/** Optional integration hook: keeps IMPL-004's OAuth flow independent of GitHub App details. */
export interface LoginBackfill { backfillInstallerOwnership(user: LoggedInUser, requestId?: string): Promise<void>; }
export class AuthService {
  private readonly store: FirestoreRuleStore; private readonly github: GitHubApiClient; private readonly loginBackfill?: LoginBackfill;
  constructor(store: FirestoreRuleStore, github: GitHubApiClient, loginBackfill?: LoginBackfill) { this.store = store; this.github = github; this.loginBackfill = loginBackfill; }
  async loginWithCode(code: string, requestId = `oauth:${generateUlid()}`): Promise<LoggedInUser> { return this.loginGitHubUser(await this.github.getAuthenticatedUser(await this.github.exchangeCodeForToken(code)), requestId); }
  async loginGitHubUser(github: GitHubUser, requestId = `oauth:${generateUlid()}`): Promise<LoggedInUser> {
    const githubUserId = String(github.id);
    const create = () => this.store.runTransaction(async (tx) => {
      const keyRef = this.store.documentRef("unique_keys", `github_user:${githubUserId}`);
      const existingKey = await tx.get(keyRef);
      const now = new Date().toISOString();
      if (existingKey.exists) {
        const user = await tx.get(this.store.documentRef("users", existingKey.data()!.targetId as string));
        if (!user.exists) throw new RuleStoreError("UNIQUE_TARGET_MISSING", 409);
        tx.update(this.store.documentRef("users", user.id), { lastLoginAt: now });
        return { ...(user.data() as LoggedInUser), lastLoginAt: now };
      }
      const userId = generateUlid(), workspaceId = generateUlid(), preferenceId = generateUlid(), memberId = generateUlid();
      const workspace: DocumentData = { id: workspaceId, kind: "personal", name: github.login, slug: `personal-${userId.toLowerCase()}`, ownerUserId: userId, githubOrgId: null, githubOrgLogin: null, status: "active", settings: { defaultLocale: "ja", prCommentRetentionDays: 180, evidenceRetentionDays: 365, allowAiAutoProposal: true, aiDataUsageConsent: false, aiProcessingAcknowledgedAt: null }, createdAt: now, updatedAt: now, deletedAt: null };
      const user: LoggedInUser = { id: userId, githubUserId, login: github.login, displayName: github.name || github.login, email: github.email ?? null, locale: "ja", personalWorkspaceId: workspaceId, createdAt: now, lastLoginAt: now, updatedAt: now, deletedAt: null };
      const preference: DocumentData = { id: preferenceId, userId, explanationLevel: "normal", reviewDisplay: {}, notifications: {}, locale: "ja", transferPolicy: TRANSFER_POLICY_PROHIBITED };
      await this.store.reserveUniqueKeys(tx, [
        { kind: "github_user", components: { githubUserId }, target: { targetTable: "users", targetId: userId } },
        { kind: "user_preference", components: { userId }, target: { targetTable: "user_preferences", targetId: preferenceId } },
        { kind: "workspace_member", components: { workspaceId, userId }, target: { targetTable: "workspace_members", targetId: memberId } },
      ]);
      tx.create(this.store.documentRef("users", userId), user); tx.create(this.store.documentRef("workspaces", workspaceId), workspace);
      tx.create(this.store.documentRef("workspace_members", memberId), { id: memberId, workspaceId, userId, role: "owner", invitedByUserId: null, joinedVia: "personal_owner", invitationId: null, createdAt: now, updatedAt: now });
      tx.create(this.store.documentRef("user_preferences", preferenceId), preference);
      await this.store.appendAuditLog(userContext(workspaceId, userId), { actor: userActor(userId), action: "user.login", targetType: "users", targetId: userId, requestId, after: { githubUserId } }, tx);
      return user;
    });
    let user: LoggedInUser;
    try { user = await create(); } catch (error) {
      if (!isRuleStoreError(error) || error.code !== "UNIQUE_VIOLATION") throw error;
      // A non-retrying storage adapter may surface the reservation race. Re-run to use its winner.
      user = await create();
    }
    await this.loginBackfill?.backfillInstallerOwnership(user, requestId); return user;
  }
}
