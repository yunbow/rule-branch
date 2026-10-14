import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (relative: string) => readFileSync(new URL("../src/" + relative, import.meta.url), "utf8");

test("login page exposes the judge demo path only through configured credentials", () => {
  const page = source("app/login/page.tsx");
  const panel = source("app/login/DemoLoginPanel.tsx");
  assert.match(page, /isJudgeDemoLoginEnabled/);
  assert.match(page, /<DemoLoginPanel \/>/);
  assert.match(panel, /デモを見る/);
  assert.match(panel, /\/api\/auth\/demo-login/);
  assert.match(panel, /X-Requested-With/);
  assert.match(panel, /デモアカウントは閲覧専用/);
});

test("judge demo workspace presents the expected review path", () => {
  const page = source("app/w/[workspaceId]/page.tsx");
  assert.match(page, /workspace\.demoMode === true/);
  assert.match(page, /HACKATHON JUDGE DEMO/);
  assert.match(page, /Driftを確認/);
  assert.match(page, /AI評価を確認/);
  assert.match(page, /反映を確認/);
  assert.match(page, /rule-branch-demo-workspace-1/);
});
