import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LatestRequest } from "../src/lib/latest-request.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("latest request rejects stale success and stale failure after a newer request succeeds", async () => {
  const lifecycle = new LatestRequest(), values: string[] = [], errors: string[] = [];
  const old = lifecycle.begin(), oldResult = deferred<string>();
  const oldCommit = oldResult.promise.then((value) => { if (old.isCurrent()) values.push(value); })
    .catch((reason: Error) => { if (old.isCurrent()) errors.push(reason.message); });
  const current = lifecycle.begin(), currentResult = deferred<string>();
  const currentCommit = currentResult.promise.then((value) => { if (current.isCurrent()) values.push(value); });

  currentResult.resolve("new-project");
  oldResult.reject(new Error("old-project failed late"));
  await Promise.all([oldCommit, currentCommit]);

  assert.equal(old.signal.aborted, true);
  assert.deepEqual(values, ["new-project"]);
  assert.deepEqual(errors, []);
});

test("invalidating a request prevents a late unmounted response from committing", async () => {
  const lifecycle = new LatestRequest(), result = deferred<string>(), values: string[] = [];
  const request = lifecycle.begin();
  const commit = result.promise.then((value) => { if (request.isCurrent()) values.push(value); });
  lifecycle.invalidate();
  result.resolve("old-job");
  await commit;
  assert.deepEqual(values, []);
  assert.equal(request.signal.aborted, true);
});

test("async UI consumers reset targets and guard mutation and response identity", () => {
  const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const polling = src("lib/hooks/useJobPolling.ts");
  const repository = src("components/domain/RepositoryAddDialog.tsx");
  const publication = src("components/domain/PublicationDashboard.tsx");
  const review = src("components/domain/CandidateReviewPanel.tsx");
  assert.match(polling, /setJob\(null\)[\s\S]*setError\(null\)/);
  assert.match(polling, /\[jobId, workspaceId\]/);
  assert.match(polling, /\[projectId, workspaceId\]/);
  assert.match(repository, /submittingRef\.current/);
  assert.match(repository, /selectedInstallationId/);
  assert.match(publication, /repositoryScope/);
  assert.match(review, /setVersions\(null\)/);
});
