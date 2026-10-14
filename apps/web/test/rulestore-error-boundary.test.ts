import assert from "node:assert/strict";
import test from "node:test";
import { signSession } from "../src/shared/auth.ts";
import { createProjectRepositoryHandlers, createRuleHandlers } from "../src/shared/http-api.ts";
import { isRuleStoreError, RuleStoreError } from "../src/shared/rulestore.ts";
import type { ProjectRepositoryService } from "../src/shared/project-repositories.ts";
import type { RulesService } from "../src/shared/rules.ts";

const secret = "error-boundary-secret";
const mutation = (path: string, body: Record<string, unknown>) => new Request(`https://test${path}`, {
  method: "POST",
  headers: {
    cookie: `rulebranch_session=${signSession({ userId: "user", issuedAt: Date.now() }, secret)}`,
    "content-type": "application/json",
    "x-requested-with": "RuleBranch",
  },
  body: JSON.stringify(body),
});

async function separatelyLoadedRuleStore() {
  const url = new URL("../src/shared/rulestore.ts", import.meta.url);
  url.searchParams.set("bundle", "separate");
  return await import(url.href) as typeof import("../src/shared/rulestore.ts");
}

test("RuleStoreError survives a duplicated module/class boundary without trusting lookalikes", async () => {
  const duplicate = await separatelyLoadedRuleStore();
  const error = new duplicate.RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "project_slug" });

  assert.equal(error instanceof RuleStoreError, false, "the test must exercise distinct class identities");
  assert.equal(isRuleStoreError(error), true);
  assert.equal(isRuleStoreError({ code: "UNIQUE_VIOLATION", status: 409, details: {} }), false);
  assert.equal(isRuleStoreError(new Error("UNIQUE_VIOLATION")), false);

  const brandedButInvalid = new duplicate.RuleStoreError("UNIQUE_VIOLATION", 409);
  Object.defineProperty(brandedButInvalid, "status", { value: 200 });
  assert.equal(isRuleStoreError(brandedButInvalid), false);
});

test("project creation preserves duplicate-slug 409 across a duplicated class boundary", async () => {
  const duplicate = await separatelyLoadedRuleStore();
  const service = {
    async createProject() {
      throw new duplicate.RuleStoreError("UNIQUE_VIOLATION", 409, { kind: "project_slug", value: "workspace:duplicate" });
    },
  } as unknown as ProjectRepositoryService;
  const response = await createProjectRepositoryHandlers(service, secret).createProject(mutation("/api/projects", { ownerWorkspaceId: "workspace" }));

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "UNIQUE_VIOLATION", details: { kind: "project_slug", value: "workspace:duplicate" } });
});

test("rule-version creation preserves stale-supersedes 422 across a duplicated class boundary", async () => {
  const duplicate = await separatelyLoadedRuleStore();
  const service = {
    async createRuleVersion() {
      throw new duplicate.RuleStoreError("SUPERSEDES_INVALID", 422);
    },
  } as unknown as RulesService;
  const response = await createRuleHandlers(service, secret).createVersion(mutation("/api/rule-versions", {
    ownerWorkspaceId: "workspace",
    ruleId: "rule",
    supersedes: "stale-version",
  }));

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "SUPERSEDES_INVALID", details: {} });
});

test("untrusted thrown values still produce a generic 500", async () => {
  const service = {
    async createRuleVersion() {
      throw { code: "SUPERSEDES_INVALID", status: 422, details: {} };
    },
  } as unknown as RulesService;
  const response = await createRuleHandlers(service, secret).createVersion(mutation("/api/rule-versions", {
    ownerWorkspaceId: "workspace",
    ruleId: "rule",
  }));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "INTERNAL_ERROR" });
});
