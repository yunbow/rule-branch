#!/usr/bin/env node

const baseUrl = (process.argv[2] ?? process.env.RULEBRANCH_PUBLIC_URL ?? "").replace(/\/$/, "");
const id = process.env.RULEBRANCH_DEMO_LOGIN_ID ?? "";
const password = process.env.RULEBRANCH_DEMO_LOGIN_PASSWORD ?? "";

if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
  console.error("Usage: RULEBRANCH_DEMO_LOGIN_ID=... RULEBRANCH_DEMO_LOGIN_PASSWORD=... node scripts/verify-judge-demo.mjs https://your-rulebranch.example");
  process.exit(2);
}
if (!id || !password) {
  console.error("RULEBRANCH_DEMO_LOGIN_ID and RULEBRANCH_DEMO_LOGIN_PASSWORD are required.");
  process.exit(2);
}

const failures = [];
const check = (condition, label, detail = "") => {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures.push(label);
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function text(response) {
  return await response.text();
}

const loginPage = await fetch(`${baseUrl}/login`, { redirect: "manual" });
const loginHtml = await text(loginPage);
check(loginPage.status === 200, "login page returns 200", `status=${loginPage.status}`);
check(loginHtml.includes("デモを見る"), "login page exposes the demo button");
check(loginHtml.includes("GitHubで続ける"), "GitHub login remains available");

const invalid = await fetch(`${baseUrl}/api/auth/demo-login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Requested-With": "RuleBranch",
  },
  body: JSON.stringify({ id, password: `${password}__invalid` }),
  redirect: "manual",
});
check(invalid.status === 401, "invalid demo password is rejected", `status=${invalid.status}`);

const login = await fetch(`${baseUrl}/api/auth/demo-login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Requested-With": "RuleBranch",
  },
  body: JSON.stringify({ id, password }),
  redirect: "manual",
});
const loginBody = await login.json().catch(() => ({}));
const setCookie = login.headers.get("set-cookie") ?? "";
const session = setCookie.match(/rulebranch_session=([^;]+)/)?.[1] ?? "";
check(login.status === 200, "demo login succeeds", `status=${login.status}`);
check(loginBody.readOnly === true, "demo account is declared read-only");
check(loginBody.workspaceId === "judge-demo-workspace", "demo workspace ID is fixed");
check(Boolean(session), "session cookie is issued");

const headers = { Cookie: `rulebranch_session=${session}` };
const workspacePath = loginBody.redirectTo ?? "/w/judge-demo-workspace";
const projectBase = "/w/judge-demo-workspace/projects/judge-demo-project";

const pages = [
  {
    label: "demo workspace",
    path: workspacePath,
    expected: ["HACKATHON JUDGE DEMO", "RuleBranch Demo Workspace 1", "Driftを確認", "AI評価を確認", "反映を確認"],
  },
  {
    label: "drift page",
    path: `${projectBase}/drift?tab=findings`,
    expected: ["Zod 3→4", "React 19", "依存関係の変更"],
  },
  {
    label: "human review queue",
    path: "/w/judge-demo-workspace/reviews?status=human_required&project=judge-demo-project",
    expected: ["Zodの入力検証パターンを安全に移行する", "人間確認", "Judge score"],
  },
  {
    label: "publication page",
    path: `${projectBase}/publications`,
    expected: ["Draft", "AGENTS.md", "CLAUDE.md"],
  },
];

for (const page of pages) {
  const response = await fetch(`${baseUrl}${page.path}`, { headers, redirect: "manual" });
  const body = await text(response);
  check(response.status === 200, `${page.label} returns 200`, `status=${response.status}`);
  for (const marker of page.expected) {
    check(body.includes(marker), `${page.label} contains "${marker}"`);
  }
}

const me = await fetch(`${baseUrl}/api/me`, { headers, redirect: "manual" });
const meBody = await me.json().catch(() => ({}));
check(me.status === 200, "/api/me returns 200", `status=${me.status}`);
const demoWorkspace = Array.isArray(meBody.workspaces)
  ? meBody.workspaces.find((workspace) => workspace?.id === "judge-demo-workspace")
  : undefined;
check(demoWorkspace?.role === "viewer", "demo workspace role is viewer");
check(meBody.user?.login === "zenn-judge-demo", "demo session uses the dedicated user");

if (failures.length) {
  console.error(`\nJudge demo smoke failed: ${failures.length} check(s).`);
  process.exit(1);
}

console.log("\nJudge demo smoke passed.");
