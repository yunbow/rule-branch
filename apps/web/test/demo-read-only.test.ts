import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { JUDGE_DEMO } from "../src/shared/demo-auth.ts";
import {
  createGitHubAppHandlers,
  createProjectRepositoryHandlers,
  createRuleHandlers,
  createUserPreferencesHandlers,
} from "../src/shared/http-api.ts";
import { createPurgeHandlers } from "../src/shared/purge-api.ts";
import { FirestoreRuleStore } from "../src/shared/rulestore.ts";
import { GitHubAppService } from "../src/shared/github-app.ts";
import { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import { RulesService } from "../src/shared/rules.ts";
import { UserPreferencesService } from "../src/shared/user-preferences.ts";
import { InMemoryFirestore } from "./fake-firestore.ts";

const secret = "demo-read-only-secret";
const cookie = `rulebranch_session=${signSession({ userId: JUDGE_DEMO.userId, issuedAt: Date.now() }, secret)}`;

function mutation(url: string, body: Record<string, unknown> = {}, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      cookie,
      "Content-Type": "application/json",
      "X-Requested-With": "RuleBranch",
    },
    body: JSON.stringify(body),
  });
}

async function expectReadOnly(response: Response) {
  assert.equal(response.status, 403);
  const body = await response.json() as { error?: unknown; details?: unknown };
  assert.equal(body.error, "DEMO_READ_ONLY");
  if ("details" in body) assert.deepEqual(body.details, {});
}

test("demo session cannot mutate preferences, projects, reviews, or purge state", async () => {
  let preferenceUpdates = 0;
  const preferences = {
    update: async () => { preferenceUpdates += 1; return {}; },
  } as unknown as UserPreferencesService;
  await expectReadOnly(await createUserPreferencesHandlers(preferences, secret).patch(
    mutation("https://rulebranch.test/api/user-preferences", { locale: "en" }, "PATCH"),
  ));
  assert.equal(preferenceUpdates, 0);

  let projectCreates = 0;
  const projects = {
    createProject: async () => { projectCreates += 1; return {}; },
  } as unknown as ProjectRepositoryService;
  await expectReadOnly(await createProjectRepositoryHandlers(projects, secret).createProject(
    mutation("https://rulebranch.test/api/projects", { ownerWorkspaceId: JUDGE_DEMO.workspaceId, name: "blocked" }),
  ));
  assert.equal(projectCreates, 0);

  let approvals = 0;
  const rules = {
    approveRuleVersion: async () => { approvals += 1; return {}; },
  } as unknown as RulesService;
  await expectReadOnly(await createRuleHandlers(rules, secret).approveVersion(
    mutation("https://rulebranch.test/api/rule-versions/version/approve", { ownerWorkspaceId: JUDGE_DEMO.workspaceId }),
    "version",
  ));
  assert.equal(approvals, 0);

  const store = new FirestoreRuleStore(new InMemoryFirestore());
  await expectReadOnly(await createPurgeHandlers(store, { verify: () => true }, "scheduler", secret).subjectRequest(
    mutation("https://rulebranch.test/api/data-subject-requests", {
      ownerWorkspaceId: JUDGE_DEMO.workspaceId,
      requestId: "blocked-purge",
    }),
  ));
});

test("demo session cannot use the side-effecting GitHub setup callback", async () => {
  let setupCalls = 0;
  const githubApp = {
    setup: async () => { setupCalls += 1; return { workspaceId: "workspace", installationId: "installation" }; },
  } as unknown as GitHubAppService;
  const response = await createGitHubAppHandlers(githubApp, secret, "webhook-secret").setup(
    new Request("https://rulebranch.test/setup?installation_id=1&setup_action=install", { headers: { cookie } }),
  );

  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("code"), "DEMO_READ_ONLY");
  assert.equal(setupCalls, 0);
});

test("demo viewer remains isolated from another tenant", async () => {
  const firestore = new InMemoryFirestore();
  const store = new FirestoreRuleStore(firestore);
  await store.runTransaction(async (tx) => {
    tx.create(store.documentRef("workspaces", "other-workspace"), {
      id: "other-workspace",
      kind: "organization",
      status: "active",
    });
    tx.create(store.documentRef("rules", "other-rule"), {
      id: "other-rule",
      ownerWorkspaceId: "other-workspace",
      title: "private",
    });
  });

  const response = await createRuleHandlers(new RulesService(store), secret).get(
    new Request("https://rulebranch.test/api/rules/other-rule?workspaceId=other-workspace", { headers: { cookie } }),
    "other-rule",
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "FORBIDDEN",
    details: { workspaceId: "other-workspace", minRole: "viewer" },
  });
});
