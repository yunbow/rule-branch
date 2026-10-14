import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const usage = new URL("docs/usage/", root);
const read = (name: string) => readFileSync(new URL(name, usage), "utf8");

test("usage guides have resolvable repository-relative links including the first publication guide", () => {
  const names = readdirSync(usage).filter((name) => name.endsWith(".md"));
  assert.ok(names.includes("first-rule-publication.md"));
  let checked = 0;
  for (const name of names) {
    const source = new URL(name, usage);
    for (const match of read(name).matchAll(/\[[^\]\n]*\]\((\.\.?\/[^)\s]+)\)/g)) {
      const path = match[1].split("#")[0];
      assert.ok(existsSync(new URL(path, source)), `${name}: missing ${path}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "must actually inspect the navigation links");
});

test("initial and update Cloud Run builds always select amd64 and the repository-root context", () => {
  const guide = read("gcp-deployment.md");
  const commands = [...guide.matchAll(/^docker build ([^\n]+)$/gm)].map((match) => match[1]);
  assert.equal(commands.length, 4, "initial/update builds for both Web and Worker");
  for (const command of commands) {
    assert.ok(command.includes("--platform=linux/amd64"), command);
    assert.match(command, /-f apps\/(web|worker)\/Dockerfile/);
    assert.ok(command.endsWith(" ."), command);
  }
  assert.ok(guide.includes("docker pull --platform=linux/amd64"));
  assert.ok(guide.includes("docker image inspect"));
});

test("deployment documents host dependencies, initial index readiness and end-to-end acceptance", () => {
  const guide = read("gcp-deployment.md");
  const update = guide.split("## 17. 更新デプロイ")[1]?.split("## 18.")[0];
  assert.ok(update);
  const install = update.indexOf("npm --prefix apps/web ci");
  const build = update.indexOf("npm --prefix apps/web run build");
  assert.ok(install >= 0 && build > install, "host npm ci must precede host build");
  const initialIndexes = guide.split("## 13. Firestore rules / indexes を deploy する")[1]?.split("## 14.")[0];
  assert.ok(initialIndexes?.includes("`READY`"));
  assert.ok(guide.includes("./first-rule-publication.md"));
  assert.ok(read("first-rule-publication.md").includes("`verified`"));
});

test("approval operations distinguish API errors, scan errors and compilation failures", () => {
  const guide = read("automatic-approval.md");
  for (const name of ["approval_scan_started", "approval_scan_completed", "approval_scan_failed", "scanId", "failed", "evaluationFailures", "evaluationApiFailures", "evaluationFailureReasons", "compilationFailures"])
    assert.ok(guide.includes(`\`${name}\``), `missing documented metric/event: ${name}`);
  assert.ok(guide.includes("## 通常停止と未配送データの回収"));
  assert.ok(guide.includes("## 緊急停止と復旧"));
  assert.ok(read("managed-instructions.md").includes("`rulebranch/rules-update`"));
});
