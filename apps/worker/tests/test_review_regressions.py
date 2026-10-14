"""Design-review regressions. DB/GitHub/compiler ports are test doubles.

The execution guard, runtime, publisher, compile handler, verifier, artifact
attribution, and managed-instruction merge are the production implementations.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from rulebranch.execution_guard import (ExecutionLost, execution_scope, compile_ownership,
    assert_current_execution, check_deadline, checkpoint)
from rulebranch.artifact_impacts import artifact_impacts
from rulebranch.github_publisher import GitHubPublisher, BRANCH
from rulebranch.managed_instructions import managed_block, update_instructions, BEGIN, END
from rulebranch.publish_verify import PublishVerifyJobHandler
from rulebranch.compile_job import CompileJobHandler
from rulebranch.compiler import CompiledArtifact
from rulebranch.job_runtime import WorkerRuntime, JobHandlerRegistry
from rulebranch.rulestore import RuleStoreContext, RuleStoreError


def blob(content):
    b = content.encode()
    return sha1(b"blob " + str(len(b)).encode() + b"\0" + b).hexdigest()


class Snap:
    def __init__(self, value): self.value = deepcopy(value); self.exists = value is not None
    def to_dict(self): return deepcopy(self.value)

@dataclass
class Ref:
    store: object
    collection: str
    id: str
    def get(self): return Snap(self.store.data.get((self.collection, self.id)))

class Tx:
    def __init__(self, store): self.store = store; self.writes = []
    def get(self, ref):
        if self.writes: raise AssertionError("read after write")
        return ref.get()
    def query(self, collection, filters, limit=None):
        if self.writes: raise AssertionError("read after write")
        values = [Snap(value) for (name, _), value in self.store.data.items() if name == collection
                  and all(value.get(field) == expected for field, expected in filters.items())]
        return values[:limit] if limit is not None else values
    def create(self, ref, value):
        check_deadline()
        if (ref.collection, ref.id) in self.store.data: raise AssertionError("duplicate create")
        self.writes.append(("create", ref, deepcopy(value)))
    def update(self, ref, value):
        check_deadline(); self.writes.append(("update", ref, deepcopy(value)))
    def delete(self, ref): check_deadline(); self.writes.append(("delete", ref, None))

class MemoryStore:
    def __init__(self):
        self.data = {}; self.transactions = []; self.sequence = 0
        self.before_transaction = None; self.fail_batch = None; self.fail_artifacts_once = False
    def put(self, collection, identifier, value): self.data[collection, identifier] = deepcopy(value)
    def _ref(self, collection, identifier): return Ref(self, collection, identifier)
    def get(self, ctx, collection, identifier):
        value = deepcopy(self.data.get((collection, identifier)))
        return value if value and value.get("ownerWorkspaceId") == ctx.workspaceId else None
    def list(self, ctx, collection, filter=None):
        return [deepcopy(v) for (c, _), v in self.data.items() if c == collection and v.get("ownerWorkspaceId") == ctx.workspaceId
                and all(v.get(k) == val for k, val in (filter or {}).items())]
    def _get_many(self, ctx, collection, ids): return [value for id in ids if (value := self.get(ctx, collection, id))]
    def runTransaction(self, callback):
        if self.before_transaction: self.before_transaction(callback)
        tx = Tx(self); assert_current_execution(self, tx)
        result = callback(tx); check_deadline()
        if self.fail_batch: self.fail_batch(tx)
        if len(tx.writes) > 450: raise AssertionError("transaction too large")
        for operation, ref, value in tx.writes:
            key = (ref.collection, ref.id)
            if operation == "delete": self.data.pop(key, None)
            elif operation == "update": self.data[key].update(value)
            else: self.data[key] = value
        self.transactions.append(len(tx.writes)); return result
    def appendAuditLog(self, ctx, entry, tx=None):
        self.sequence += 1; id = f"audit-{self.sequence}"
        write = lambda t: t.create(self._ref("audit_logs", id), {**entry, "id": id, "ownerWorkspaceId": ctx.workspaceId})
        write(tx) if tx else self.runTransaction(write)
    def updateAnalysisJobStatus(self, ctx, id, status, opts=None):
        opts = opts or {}
        def write(tx):
            ref = self._ref("analysis_jobs", id); job = tx.get(ref).to_dict()
            if "expectedExecutionOwner" in opts and job.get("executionOwner") != opts["expectedExecutionOwner"]: raise RuleStoreError("EXECUTION_CHANGED", 409)
            if "expectedStartedAt" in opts and job.get("startedAt") != opts["expectedStartedAt"]: raise RuleStoreError("EXECUTION_CHANGED", 409)
            edges = {"queued": {"running"}, "failed": {"running"}, "running": {"done", "failed"}}
            if status not in edges.get(job["status"], set()): raise RuleStoreError("INVALID_STATUS_TRANSITION", 422)
            patch = {"status": status, "error": opts.get("error"), "warnings": opts.get("warnings", [])}
            if status == "running": patch.update({"executionOwner": opts.get("executionOwner"), "executionDeadline": opts.get("executionDeadline"), "startedAt": datetime.now(UTC).isoformat()})
            if status == "failed" and opts.get("consumeAttempt", True):
                patch["attempts"] = job.get("attempts", 0) + 1
                if patch["attempts"] >= opts.get("maxAttempts", 5): patch["status"] = "dead"
            tx.update(ref, patch); return {**job, **patch}
        return self.runTransaction(write)
    def _resolve_rules(self, ctx, project, repository, *args): return self.get(ctx, "resolution_snapshots", "snap")
    def writeCompiledArtifacts(self, ctx, artifacts):
        if self.fail_artifacts_once:
            self.fail_artifacts_once = False; raise RuntimeError("injected DB outage after GitHub write")
        def write(tx):
            for artifact in artifacts: tx.create(self._ref("compiled_artifacts", artifact["id"]), artifact)
        self.runTransaction(write)
    def openRevisionPr(self, ctx, value):
        ref = self._ref("revision_prs", value["id"])
        def write(tx):
            exists = tx.get(ref).exists
            (tx.update if exists else tx.create)(ref, value)
        self.runTransaction(write)
    def pruneCompiledArtifacts(self, ctx, revision, keep):
        values = self.list(ctx, "compiled_artifacts", {"revisionPrId": revision})
        def write(tx):
            for value in values:
                if value["id"] not in keep: tx.delete(self._ref("compiled_artifacts", value["id"]))
        self.runTransaction(write)


class Git:
    def __init__(self):
        self.heads = {"main": "base"}; self.trees = {"base": {}}; self.blobs = {}
        self.remote = None; self.refs = []; self.parents = {}; self.created = 0; self.edited = []
        self.on_find = None; self.on_commit = None; self.on_tree = None; self.find_count = 0
    def branch_head(self, repo, branch): return self.heads[branch]
    def tree(self, repo, head):
        if self.on_tree: self.on_tree()
        return dict(self.trees[head])
    def read_blob(self, repo, sha): return self.blobs[sha]
    def blob(self, repo, content): sha = blob(content); self.blobs[sha] = content; return sha
    def new_tree(self, repo, base, entries):
        value = dict(self.trees[base])
        for entry in entries:
            if entry["sha"] is None: value.pop(entry["path"], None)
            else: value[entry["path"]] = entry["sha"]
        id = f"tree-{len(self.trees)}"; self.trees[id] = value; return id
    def commit(self, repo, tree, parent, message):
        id = f"commit-{len(self.trees)}"; self.trees[id] = dict(self.trees[tree]); self.parents[id] = parent
        if self.on_commit: self.on_commit()
        return id
    def ref(self, repo, branch, sha, force):
        if not force and branch in self.heads and self.parents[sha] != self.heads[branch]: raise ValueError("non-fast-forward")
        self.refs.append(force); self.heads[branch] = sha
    def find_open_pull_request(self, *args):
        self.find_count += 1
        if self.on_find: self.on_find(self.find_count)
        return deepcopy(self.remote)
    def open_pull_request(self, *args):
        self.created += 1; self.remote = {"number": 9, "url": "https://example.test/pr/9"}; return deepcopy(self.remote)
    def edit_pull_request(self, repo, number, body): self.edited.append(number)
    def close_pull_request(self, repo, number): self.remote = None
    def set_file(self, branch, path, content):
        head = f"human-{len(self.trees)}"; self.trees[head] = dict(self.trees[self.heads[branch]])
        self.trees[head][path] = self.blob({}, content); self.heads[branch] = head


CTX = RuleStoreContext("w", None, "system")
def seed(count=1, path="AGENTS.md", repo_id="repo", store=None):
    store = store or MemoryStore()
    repo = {"id": repo_id, "ownerWorkspaceId": "w", "projectId": "p", "defaultBranch": "main", "status": "active", "compileTargets": ["agents-md"]}
    store.put("repositories", repo_id, repo)
    store.put("projects", "p", {"id": "p", "ownerWorkspaceId": "w", "status": "active"})
    snapshot_id = "snap" if repo_id == "repo" else f"snap-{repo_id}"
    revision_id = "pr" if repo_id == "repo" else f"pr-{repo_id}"
    ids = []
    for n in range(count):
        id, version = f"r-{n}", f"v-{n}"; ids.append(version)
        store.put("rules", id, {"id": id, "ownerWorkspaceId": "w", "status": "active", "currentVersionId": version})
        store.put("rule_versions", version, {"id": version, "ownerWorkspaceId": "w", "ruleId": id, "enforcement": "default"})
    store.put("resolution_snapshots", snapshot_id, {"id": snapshot_id, "ownerWorkspaceId": "w", "projectId": "p", "repositoryId": repo_id, "ruleVersionIds": ids})
    pr = {"id": revision_id, "ownerWorkspaceId": "w", "repositoryId": repo_id, "projectId": "p", "resolutionSnapshotId": snapshot_id, "status": "merged", "prNumber": 1}
    store.put("revision_prs", revision_id, pr)
    store.put("compiled_artifacts", f"art-{repo_id}", {"id": f"art-{repo_id}", "ownerWorkspaceId": "w", "revisionPrId": revision_id,
        "resolutionSnapshotId": snapshot_id, "path": path, "gitBlobSha": "expected", "ruleId": None})
    return store, repo, pr

class Trees:
    def __init__(self, path="AGENTS.md"): self.head = "changed-head"; self.values = {path: "changed"}; self.reads = 0
    def branch_head(self, *args): return self.head
    def tree(self, *args): self.reads += 1; return dict(self.values), False
    def contents_tree(self, *args): return dict(self.values)


def verify_job(repo="repo", pr="pr"):
    return {"ownerWorkspaceId": "w", "payload": {"repositoryId": repo, "revisionPrId": pr, "commitSha": "event-head"}}


def running(store, seconds=10):
    job = {"id": "job", "ownerWorkspaceId": "w", "projectId": "p", "type": "compile", "status": "running", "attempts": 0,
           "executionOwner": "old", "executionDeadline": (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()}
    store.put("analysis_jobs", "job", job); return job

class ExecutionTests(unittest.TestCase):
    def test_successor_rejects_old_domain_write(self):
        store = MemoryStore(); job = running(store)
        with execution_scope(store, job):
            store.data["analysis_jobs", "job"]["executionOwner"] = "new"
            with self.assertRaises(ExecutionLost): store.runTransaction(lambda tx: tx.create(store._ref("rules", "bad"), {}))
        self.assertNotIn(("rules", "bad"), store.data)
    def test_successor_rejects_old_done(self):
        store = MemoryStore(); job = running(store)
        with execution_scope(store, job):
            store.data["analysis_jobs", "job"]["executionOwner"] = "new"
            with self.assertRaises(ExecutionLost): store.updateAnalysisJobStatus(CTX, "job", "done")
        self.assertEqual(store.data["analysis_jobs", "job"]["status"], "running")
    def test_successor_rejects_old_failure(self):
        store = MemoryStore(); job = running(store)
        with execution_scope(store, job):
            store.data["analysis_jobs", "job"]["executionOwner"] = "new"
            with self.assertRaises(ExecutionLost): store.updateAnalysisJobStatus(CTX, "job", "failed")
        self.assertEqual(store.data["analysis_jobs", "job"]["attempts"], 0)
    def test_expired_scope_refuses_work(self):
        store = MemoryStore(); job = running(store, -1)
        with self.assertRaises(ExecutionLost):
            with execution_scope(store, job): self.fail("entered expired execution")
    def test_compile_owner_change_is_rejected(self):
        store, repo, _ = seed()
        store.data["repositories", "repo"]["compileLease"] = {"owner": "old", "expiresAt": (datetime.now(UTC)+timedelta(seconds=10)).isoformat()}
        with compile_ownership(store, "w", "repo", "old"):
            store.data["repositories", "repo"]["compileLease"]["owner"] = "new"
            with self.assertRaises(ExecutionLost): checkpoint()
    def test_removed_repository_revokes_compile_lease_even_before_expiration(self):
        store, _, _ = seed()
        lease = {"owner": "owner", "expiresAt": (datetime.now(UTC) + timedelta(minutes=1)).isoformat()}
        store.data["repositories", "repo"]["compileLease"] = lease
        with compile_ownership(store, "w", "repo", "owner"):
            checkpoint()  # A healthy lease works before unlink.
            store.data["repositories", "repo"].update({
                "status": "removed", "deletedAt": datetime.now(UTC).isoformat(),
            })
            with self.assertRaises(ExecutionLost):
                checkpoint()  # Unlink must fence a running publisher.
        with self.assertRaises(ExecutionLost):
            with compile_ownership(store, "w", "repo", "owner"):
                checkpoint()
    def test_deleted_job_refuses_old_attempt(self):
        store = MemoryStore(); job = running(store)
        with execution_scope(store, job):
            del store.data["analysis_jobs", "job"]
            with self.assertRaises(ExecutionLost): checkpoint()
    def test_context_does_not_leak_after_error(self):
        store = MemoryStore(); job = running(store)
        with self.assertRaises(ValueError):
            with execution_scope(store, job): raise ValueError("injected")
        del store.data["analysis_jobs", "job"]
        checkpoint()
    def test_hard_deadline_stops_process_before_late_write(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)/"late.txt"
            code = '''from datetime import UTC,datetime,timedelta
from rulebranch.execution_guard import execution_scope
import time,sys
from pathlib import Path
job={"id":"j","ownerWorkspaceId":"w","executionOwner":"o","executionDeadline":(datetime.now(UTC)+timedelta(seconds=0.1)).isoformat()}
with execution_scope(object(),job,hard_deadline=True):
    time.sleep(2)
    Path(sys.argv[1]).write_text("late")
'''
            result = subprocess.run([sys.executable, "-c", code, str(target)], timeout=5, capture_output=True)
            self.assertEqual(result.returncode, 124, result.stderr.decode()); self.assertFalse(target.exists())
    def test_watchdog_cancelled_on_success(self):
        code = '''from datetime import UTC,datetime,timedelta
from rulebranch.execution_guard import execution_scope
import time
job={"id":"j","ownerWorkspaceId":"w","executionOwner":"o","executionDeadline":(datetime.now(UTC)+timedelta(seconds=0.1)).isoformat()}
with execution_scope(object(),job,hard_deadline=True): pass
time.sleep(0.2)
'''
        result = subprocess.run([sys.executable, "-c", code], timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

class RuntimeTests(unittest.TestCase):
    def runtime(self, callback):
        store, _, _ = seed(); job = running(store); job.update({"status": "queued", "startedAt": None}); store.put("analysis_jobs", "job", job)
        registry = JobHandlerRegistry(); registry.register("purge", lambda *_: None); registry.register("compile", callback)
        return store, WorkerRuntime(store, object(), "unused", registry)
    def test_claim_passes_new_owner_to_handler(self):
        seen = []; store, runtime = self.runtime(lambda job, _: seen.append(job) or {})
        self.assertEqual(runtime.run_job("w", "job"), "done"); self.assertNotEqual(seen[0]["executionOwner"], "old")
    def test_lost_owner_does_not_finish_successor(self):
        def callback(job, _): store.data["analysis_jobs", "job"]["executionOwner"] = "successor"
        store, runtime = self.runtime(callback)
        self.assertEqual(runtime.run_job("w", "job"), "leased")
        self.assertEqual(store.data["analysis_jobs", "job"]["status"], "running")
    def test_lost_owner_exception_does_not_fail_successor(self):
        def callback(job, _):
            store.data["analysis_jobs", "job"]["executionOwner"] = "successor"; raise RuntimeError("late")
        store, runtime = self.runtime(callback)
        self.assertEqual(runtime.run_job("w", "job"), "leased"); self.assertEqual(store.data["analysis_jobs", "job"]["attempts"], 0)
    def test_recovery_checks_observed_attempt(self):
        store, runtime = self.runtime(lambda *_: {})
        store.data["analysis_jobs", "job"].update({"status": "running", "startedAt": (datetime.now(UTC)-timedelta(minutes=16)).isoformat()})
        def before(_):
            store.before_transaction = None; store.data["analysis_jobs", "job"].update({"executionOwner": "successor", "startedAt": datetime.now(UTC).isoformat()})
        store.before_transaction = before
        self.assertEqual(runtime.run_job("w", "job"), "leased"); self.assertEqual(store.data["analysis_jobs", "job"]["attempts"], 0)
    def test_recent_running_backs_off(self):
        store, runtime = self.runtime(lambda *_: self.fail("should not execute"))
        store.data["analysis_jobs", "job"].update({"status": "running", "startedAt": datetime.now(UTC).isoformat()})
        self.assertEqual(runtime.run_job("w", "job"), "leased")
    def test_terminal_noop(self):
        store, runtime = self.runtime(lambda *_: self.fail("should not execute")); store.data["analysis_jobs", "job"]["status"] = "done"
        self.assertEqual(runtime.run_job("w", "job"), "done")

class PublicationTests(unittest.TestCase):
    def test_late_unrecorded_pr_refuses_any_ref_update(self):
        api = Git(); api.remote = {"number": 9, "url": "test"}
        with self.assertRaises(ValueError): GitHubPublisher(api).publish({"defaultBranch": "main"}, [], [])
        self.assertEqual(api.refs, [])
    def test_recovered_pr_uses_nonforce(self):
        api = Git(); api.heads[BRANCH] = "base"; api.remote = {"number": 9, "url": "test"}; publisher = GitHubPublisher(api)
        existing = publisher.recover_open({"defaultBranch": "main"})
        publisher.publish({"defaultBranch": "main"}, [], [], existing, expected_head="base")
        self.assertEqual(api.refs, [False]); self.assertEqual(api.created, 0)
    def test_head_movement_before_publication_refused(self):
        api = Git(); publisher = GitHubPublisher(api)
        with self.assertRaises(ValueError): publisher.publish({"defaultBranch": "main"}, [], [], expected_head="obsolete")
        self.assertEqual(api.refs, [])
    def test_head_movement_during_object_creation_refused(self):
        api = Git(); api.on_commit = lambda: api.heads.update({"main": "moved"})
        with self.assertRaises(ValueError): GitHubPublisher(api).publish({"defaultBranch": "main"}, [], [], expected_head="base")
        self.assertEqual(api.refs, [])
    def test_open_pr_appearing_midflight_refused(self):
        api = Git(); api.on_find = lambda n: setattr(api, "remote", {"number": 9, "url": "test"}) if n == 2 else None
        with self.assertRaises(ValueError): GitHubPublisher(api).publish({"defaultBranch": "main"}, [], [], expected_head="base")
        self.assertEqual(api.refs, [])
    def test_lost_owner_before_ref_refused(self):
        api = Git(); store = MemoryStore(); job = running(store)
        api.on_commit = lambda: store.data["analysis_jobs", "job"].update({"executionOwner": "new"})
        with execution_scope(store, job):
            with self.assertRaises(ExecutionLost): GitHubPublisher(api).publish({"defaultBranch": "main"}, [], [])
        self.assertEqual(api.refs, [])
    def test_invalid_bytes_never_published(self):
        api = Git()
        with self.assertRaises(ValueError): GitHubPublisher(api).publish({"defaultBranch": "main"}, [{"path": "AGENTS.md", "publicationContent": "x", "gitBlobSha": "bad"}], [])
        self.assertEqual(api.refs, [])
    def test_full_compile_retry_preserves_unrecorded_pr_manual_edit(self):
        store, repo, _ = seed(); del store.data["revision_prs", "pr"]; del store.data["compiled_artifacts", "art-repo"]
        api = Git(); handler = CompileJobHandler(store, GitHubPublisher(api))
        text = managed_block("generated"); artifact = CompiledArtifact("agents-md", "AGENTS.md", "hash", text, False, blob(text), None, publicationContent=text)
        job = {"id": "compile-job", "ownerWorkspaceId": "w", "payload": {"repositoryId": "repo"}}
        store.fail_artifacts_once = True
        with patch("rulebranch.compile_job.compile", return_value=[artifact]):
            with self.assertRaises(RuntimeError): handler(job, None)
            api.set_file(BRANCH, "AGENTS.md", "manual only in unrecorded PR\r\n" + text + "manual tail\n")
            handler(job, None)
        final = api.blobs[api.trees[api.heads[BRANCH]]["AGENTS.md"]]
        self.assertEqual(final, "manual only in unrecorded PR\r\n" + text + "manual tail\n")
        self.assertEqual(api.refs, [True, False]); self.assertEqual(api.created, 1)
        self.assertEqual(len(store.list(CTX, "revision_prs")), 1)

class VerificationTests(unittest.TestCase):
    def test_all_three_aggregate_paths_stale_and_repair(self):
        for path in ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]:
            with self.subTest(path=path):
                store, _, _ = seed(2, path); git = Trees(path); handler = PublishVerifyJobHandler(store, git)
                handler(verify_job(), None)
                self.assertEqual(len(store.list(CTX, "drift_findings")), 2)
                self.assertTrue(all(v["status"] == "stale" for v in store.list(CTX, "rules")))
                git.head = "fixed"; git.values[path] = "expected"; handler(verify_job(), None)
                self.assertTrue(all(v["status"] == "resolved" for v in store.list(CTX, "drift_findings")))
                self.assertTrue(all(v["status"] == "active" for v in store.list(CTX, "rules")))
    def test_more_than_fifty_rules_not_truncated(self):
        store, _, _ = seed(75); handler = PublishVerifyJobHandler(store, Trees()); handler(verify_job(), None)
        self.assertEqual(len(store.list(CTX, "drift_findings")), 75); self.assertLessEqual(max(store.transactions), 450)
        self.assertTrue(store.data["revision_prs", "pr"]["verification"]["findingsComplete"])
    def test_mismatch_redelivery_is_noop_after_completion(self):
        store, _, _ = seed(); git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None); before = len(store.list(CTX, "change_triggers")); handler(verify_job(), None)
        self.assertEqual(len(store.list(CTX, "change_triggers")), before); self.assertEqual(git.reads, 1)
    def test_interrupted_batches_resume_without_duplicate_findings(self):
        store, _, _ = seed(75); handler = PublishVerifyJobHandler(store, Trees())
        def fail(tx):
            creates = any(op == "create" and ref.collection == "drift_findings" for op, ref, _ in tx.writes)
            if creates and len(store.list(CTX, "drift_findings")) >= 20:
                store.fail_batch = None; raise RuntimeError("interrupted after first batch")
        store.fail_batch = fail
        with self.assertRaises(RuntimeError): handler(verify_job(), None)
        self.assertEqual(len(store.list(CTX, "drift_findings")), 20)
        self.assertFalse(store.data["revision_prs", "pr"]["verification"].get("findingsComplete", False))
        handler(verify_job(), None)
        findings = store.list(CTX, "drift_findings")
        self.assertEqual(len(findings), 75); self.assertEqual(len({(v["ruleId"], v["path"]) for v in findings}), 75)
    def test_large_verified_repair_resumes_after_interrupted_resolution_batch(self):
        store, _, _ = seed(231); git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None)
        git.head = "fixed"; git.values["AGENTS.md"] = "expected"
        def fail(tx):
            resolves = any(op == "update" and ref.collection == "drift_findings" and value.get("status") == "resolved"
                           for op, ref, value in tx.writes)
            if resolves:
                store.fail_batch = None
                raise RuntimeError("interrupted during resolution")
        store.fail_batch = fail
        with self.assertRaisesRegex(RuntimeError, "interrupted during resolution"):
            handler(verify_job(), None)
        self.assertEqual(store.data["revision_prs", "pr"]["verification"]["state"], "verified")
        handler(verify_job(), None)
        self.assertTrue(all(value["status"] == "resolved" for value in store.list(CTX, "drift_findings")))
        self.assertTrue(all(value["status"] == "active" for value in store.list(CTX, "rules")))
        self.assertLessEqual(max(store.transactions), 450)
    def test_closed_history_does_not_prevent_rule_reactivation(self):
        store, _, _ = seed();
        for index in range(301):
            store.put("drift_findings", f"closed-{index}", {"id": f"closed-{index}", "ownerWorkspaceId": "w",
                "ruleId": "r-0", "driftType": "artifact_mismatch", "status": "resolved"})
        git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None)
        git.head = "fixed"; git.values["AGENTS.md"] = "expected"
        handler(verify_job(), None)
        self.assertEqual(store.data["rules", "r-0"]["status"], "active")
        self.assertEqual(len([value for value in store.list(CTX, "drift_findings") if value["status"] == "resolved"]), 302)
    def test_pending_finding_inserted_before_activation_transaction_keeps_rule_stale(self):
        store, _, _ = seed(); git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None)
        git.head = "fixed"; git.values["AGENTS.md"] = "expected"
        def insert(callback):
            if callback.__name__ != "activate": return
            store.before_transaction = None
            store.put("drift_findings", "dependency-race", {"id": "dependency-race", "ownerWorkspaceId": "w",
                "ruleId": "r-0", "driftType": "dependency_update", "status": "open"})
            store.data["rules", "r-0"].update({"status": "stale", "updatedAt": datetime.now(UTC).isoformat()})
        store.before_transaction = insert
        handler(verify_job(), None)
        self.assertEqual(store.data["drift_findings", "dependency-race"]["status"], "open")
        self.assertEqual(store.data["rules", "r-0"]["status"], "stale")
    def test_other_repository_remains_stale(self):
        store, _, _ = seed(); seed(repo_id="other", store=store); git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None); handler(verify_job("other", "pr-other"), None)
        git.head = "fixed"; git.values["AGENTS.md"] = "expected"; handler(verify_job(), None)
        open_findings = [v for v in store.list(CTX, "drift_findings") if v["status"] == "open"]
        self.assertEqual({v["repositoryId"] for v in open_findings}, {"other"})
        self.assertEqual(store.data["rules", "r-0"]["status"], "stale")
    def test_other_drift_survives_repair(self):
        store, _, _ = seed(); git = Trees(); handler = PublishVerifyJobHandler(store, git); handler(verify_job(), None)
        store.put("drift_findings", "dependency", {"id": "dependency", "ownerWorkspaceId": "w", "ruleId": "r-0", "driftType": "dependency_update", "status": "open"})
        git.head = "fixed"; git.values["AGENTS.md"] = "expected"; handler(verify_job(), None)
        self.assertEqual(store.data["rules", "r-0"]["status"], "stale")
    def test_newer_current_version_not_staled_by_old_publication(self):
        store, _, _ = seed(); store.data["rules", "r-0"]["currentVersionId"] = "newer"
        PublishVerifyJobHandler(store, Trees())(verify_job(), None)
        self.assertEqual(store.data["rules", "r-0"]["status"], "active")
        self.assertEqual(store.list(CTX, "drift_findings")[0]["ruleVersionId"], "v-0")
    def test_new_snapshot_version_does_not_reuse_old_open_finding(self):
        store, _, _ = seed(); git = Trees(); handler = PublishVerifyJobHandler(store, git)
        handler(verify_job(), None)
        store.put("rule_versions", "v-1", {"id": "v-1", "ownerWorkspaceId": "w", "ruleId": "r-0"})
        store.data["resolution_snapshots", "snap"]["ruleVersionIds"] = ["v-1"]
        store.data["rules", "r-0"].update({"currentVersionId": "v-1", "status": "active", "staleSince": None})
        store.data["revision_prs", "pr"].pop("verification")
        git.head = "newer-changed-head"
        handler(verify_job(), None)
        findings = store.list(CTX, "drift_findings")
        self.assertEqual({finding["ruleVersionId"] for finding in findings}, {"v-0", "v-1"})
        self.assertEqual(store.data["rules", "r-0"]["status"], "stale")
    def test_missing_snapshot_is_fail_closed(self):
        store, _, _ = seed(); del store.data["resolution_snapshots", "snap"]
        with self.assertRaises(ValueError): PublishVerifyJobHandler(store, Trees())(verify_job(), None)
        self.assertNotIn("verification", store.data["revision_prs", "pr"])
    def test_snapshot_changed_before_transaction_cannot_mark_mismatch(self):
        store, _, _ = seed()
        def change(_):
            store.before_transaction = None; store.data["revision_prs", "pr"]["resolutionSnapshotId"] = "new-snapshot"
        store.before_transaction = change
        PublishVerifyJobHandler(store, Trees())(verify_job(), None)
        self.assertEqual(store.list(CTX, "drift_findings"), [])
    def test_recompile_rebaseline_resolves_aggregate_findings(self):
        store, repo, pr = seed(); git = Trees(); PublishVerifyJobHandler(store, git)(verify_job(), None)
        snap = store.get(CTX, "resolution_snapshots", "snap"); artifacts = store.list(CTX, "compiled_artifacts")
        CompileJobHandler(store, GitHubPublisher(Git()))._rebaseline_merged(
            CTX, pr, snap, repo, artifacts, "fixed", datetime.now(UTC).isoformat(), [])
        self.assertTrue(all(v["status"] == "resolved" for v in store.list(CTX, "drift_findings")))
        self.assertEqual(store.data["rules", "r-0"]["status"], "active")
    def test_large_recompile_rebaseline_is_bounded_and_preserves_other_drift(self):
        store, repo, pr = seed(231); PublishVerifyJobHandler(store, Trees())(verify_job(), None)
        store.put("drift_findings", "dependency", {"id": "dependency", "ownerWorkspaceId": "w", "ruleId": "r-0", "driftType": "dependency_update", "status": "open"})
        snap = store.get(CTX, "resolution_snapshots", "snap"); artifacts = store.list(CTX, "compiled_artifacts")
        CompileJobHandler(store, GitHubPublisher(Git()))._rebaseline_merged(
            CTX, pr, snap, repo, artifacts, "fixed", datetime.now(UTC).isoformat(), [])
        artifact_findings = [value for value in store.list(CTX, "drift_findings") if value.get("driftType") == "artifact_mismatch"]
        self.assertTrue(all(value["status"] == "resolved" for value in artifact_findings))
        self.assertEqual(store.data["rules", "r-0"]["status"], "stale")
        self.assertTrue(all(store.data["rules", f"r-{index}"]["status"] == "active" for index in range(1, 231)))
        self.assertLessEqual(max(store.transactions), 450)

class ImpactTests(unittest.TestCase):
    def test_snapshot_repository_boundary(self):
        store, _, pr = seed(); store.data["resolution_snapshots", "snap"]["repositoryId"] = "another"
        with self.assertRaises(ValueError): artifact_impacts(store, CTX, pr, store.list(CTX, "compiled_artifacts"))
    def test_missing_version_refused(self):
        store, _, pr = seed(); del store.data["rule_versions", "v-0"]
        with self.assertRaises(ValueError): artifact_impacts(store, CTX, pr, store.list(CTX, "compiled_artifacts"))
    def test_personal_rule_excluded_when_legacy_version_has_no_enforcement(self):
        store, _, pr = seed(); store.data["rules", "r-0"]["enforcement"] = "personal"
        store.data["rule_versions", "v-0"].pop("enforcement")
        self.assertEqual(artifact_impacts(store, CTX, pr, store.list(CTX, "compiled_artifacts")), [])
    def test_missing_or_cross_tenant_rule_refused(self):
        store, _, pr = seed(); store.data["rule_versions", "v-0"]["ruleId"] = "missing"
        with self.assertRaises(ValueError): artifact_impacts(store, CTX, pr, store.list(CTX, "compiled_artifacts"))
        store.put("rules", "foreign", {"id": "foreign", "ownerWorkspaceId": "other", "enforcement": "default"})
        store.data["rule_versions", "v-0"]["ruleId"] = "foreign"
        with self.assertRaises(ValueError): artifact_impacts(store, CTX, pr, store.list(CTX, "compiled_artifacts"))
    def test_duplicate_artifact_rule_pair_deduped(self):
        store, _, pr = seed(); values = store.list(CTX, "compiled_artifacts")
        self.assertEqual(len(artifact_impacts(store, CTX, pr, values + values)), 1)

class ManagedInstructionTests(unittest.TestCase):
    def test_manual_bytes_outside_preserved(self):
        old = "---\r\nmanual: yes\r\n---\r\n" + managed_block("old") + "tail\r\n"
        self.assertEqual(update_instructions(old, managed_block("new")), old.replace(managed_block("old"), managed_block("new")))
    def test_inside_edits_are_generated_content(self):
        self.assertEqual(update_instructions(managed_block("human changed inside"), managed_block("new")), managed_block("new"))
    def test_unverified_legacy_refused(self):
        with self.assertRaises(ValueError): update_instructions("Generated by RuleBranch. human edit", "new")
    def test_ambiguous_markers_refused(self):
        with self.assertRaises(ValueError): update_instructions(managed_block("a") + managed_block("b"), managed_block("c"))

if __name__ == "__main__": unittest.main()
