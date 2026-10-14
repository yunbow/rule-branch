from __future__ import annotations
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from fake_oidc import FakeOidcVerifier
from rulebranch.job_runtime import MAX_TASK_BODY_BYTES, GoogleOidcVerifier, JobHandlerRegistry, WorkerRuntime
from rulebranch.main import _content_length
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError, sha256HexString

CTX = RuleStoreContext("w", "u")
def make_input(key: str = "bootstrap:p") -> dict[str, object]: return {"type": "bootstrap", "projectId": "p", "payload": {"a": 1}, "idempotencyKey": key, "requestId": "r"}
class AnalysisJobsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = InMemoryFirestore(); self.store = FirestoreRuleStore(self.db)
        self.db.put("projects", "p", {"id": "p", "ownerWorkspaceId": "w", "status": "active", "deletedAt": None})
        self.db.put("projects", "other-p", {"id": "other-p", "ownerWorkspaceId": "other", "status": "active", "deletedAt": None})
    def test_idempotency_dead_release_and_warnings(self) -> None:
        a = self.store.createAnalysisJob(CTX, make_input()); b = self.store.createAnalysisJob(CTX, make_input()); self.assertTrue(a["created"]); self.assertFalse(b["created"]); self.assertEqual(a["job"]["id"], b["job"]["id"])
        id = a["job"]["id"]; self.store.updateAnalysisJobStatus(CTX, id, "running"); warnings = [{"code": "schema_retry", "message": str(n)} for n in range(21)]; done = self.store.updateAnalysisJobStatus(CTX, id, "done", {"warnings": warnings}); self.assertEqual(len(done["warnings"]), 20); self.assertEqual(done["warningsOverflow"], 1); self.assertFalse(self.store.createAnalysisJob(CTX, make_input())["created"])
        dead = self.store.createAnalysisJob(CTX, make_input("bootstrap:q"))["job"]["id"]
        for _ in range(5): self.store.updateAnalysisJobStatus(CTX, dead, "running"); state = self.store.updateAnalysisJobStatus(CTX, dead, "failed")
        self.assertEqual(state["status"], "dead"); self.assertIsNone(self.store.get(CTX, "unique_keys", "job_idempotency:" + sha256HexString("bootstrap:q"))); self.assertTrue(self.store.createAnalysisJob(CTX, make_input("bootstrap:q"))["created"])
    def test_validation(self) -> None:
        with self.assertRaises(RuleStoreError): self.store.createAnalysisJob(CTX, {**make_input(), "idempotencyKey": "bad:p"})
        with self.assertRaises(RuleStoreError) as caught: self.store.createAnalysisJob(CTX, {**make_input(), "payload": {"x": "x" * (65 * 1024)}})
        self.assertEqual(caught.exception.status, 422)
    def test_idempotency_collision_never_returns_another_workspace_job(self) -> None:
        first = self.store.createAnalysisJob(CTX, make_input())
        with self.assertRaises(RuleStoreError) as caught:
            self.store.createAnalysisJob(RuleStoreContext("other", "attacker"), {**make_input(), "projectId": "other-p"})
        self.assertEqual(caught.exception.code, "UNIQUE_VIOLATION")
        self.assertEqual(self.store.list(RuleStoreContext("other", "attacker"), "analysis_jobs"), [])
        self.assertEqual(first["job"]["ownerWorkspaceId"], "w")
    def test_runtime_auth_and_finally_removes_directories_for_all_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            registry = JobHandlerRegistry(); runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, tmp_root=Path(root))
            self.assertEqual(runtime.handle_http("POST", "/tasks/analysis-jobs", {}, b"{}").status, 401); self.assertEqual(runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer bad"}, b"{}").status, 403)
            for suffix, handler, expected_status in [("ok", lambda _j, path: {"warnings": []}, 204), ("bad", lambda _j, path: {"success": False}, 500), ("boom", lambda _j, path: (_ for _ in ()).throw(RuntimeError("boom")), 500)]:
                registry.register("bootstrap", handler); job = self.store.createAnalysisJob(CTX, make_input("bootstrap:" + suffix))["job"]; response = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode()); self.assertEqual(response.status, expected_status); self.assertEqual(list(Path(root).iterdir()), [])
            registry = JobHandlerRegistry(); runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, tmp_root=Path(root)); job = self.store.createAnalysisJob(CTX, make_input("bootstrap:unregistered"))["job"]; runtime.run_job("w", job["id"]); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "failed")

    def test_malformed_job_id_cannot_escape_or_delete_the_temporary_root(self) -> None:
        with tempfile.TemporaryDirectory() as parent:
            tmp_root = Path(parent) / "worker"; marker = Path(parent) / "keep.txt"; marker.write_text("keep")
            job = {"id": "..", "ownerWorkspaceId": "w", "projectId": "p", "type": "bootstrap", "payload": {},
                   "status": "queued", "attempts": 0, "idempotencyKey": "bootstrap:malformed", "error": None,
                   "warnings": [], "warningsOverflow": 0, "createdAt": datetime.now(UTC).isoformat(), "startedAt": None}
            self.db.put("analysis_jobs", "..", job)
            seen: list[Path] = []
            registry = JobHandlerRegistry(); registry.register("bootstrap", lambda _job, path: seen.append(path) or {})
            runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, tmp_root=tmp_root)
            self.assertEqual(runtime.run_job("w", ".."), "done")
            self.assertTrue(marker.exists()); self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0].parent, tmp_root); self.assertFalse(seen[0].exists())
    def test_oidc_verifier_requires_configured_service_account_email(self) -> None:
        verifier = GoogleOidcVerifier("worker@example.iam.gserviceaccount.com")
        self.assertTrue(verifier._claims_match({"email": "worker@example.iam.gserviceaccount.com", "email_verified": True}))
        self.assertFalse(verifier._claims_match({"email": "attacker@example.iam.gserviceaccount.com", "email_verified": True}))
        self.assertFalse(verifier._claims_match({"email": "worker@example.iam.gserviceaccount.com", "email_verified": False}))
    def test_http_body_is_bounded_before_parsing_or_reading(self) -> None:
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker")
        self.assertEqual(runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, b"x" * (MAX_TASK_BODY_BYTES + 1)).status, 413)
        self.assertEqual(_content_length(str(MAX_TASK_BODY_BYTES)), MAX_TASK_BODY_BYTES)
        with self.assertRaises(ValueError): _content_length("-1")
        with self.assertRaises(ValueError): _content_length("invalid")
        with self.assertRaises(OverflowError): _content_length(str(MAX_TASK_BODY_BYTES + 1))
    def test_runtime_returns_204_after_retry_limit_marks_job_dead(self) -> None:
        registry = JobHandlerRegistry(); registry.register("bootstrap", lambda _j, _path: {"success": False})
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, max_attempts=1)
        job = self.store.createAnalysisJob(CTX, make_input("bootstrap:dead"))["job"]
        response = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode())
        self.assertEqual(response.status, 204)
        self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "dead")
    def test_redelivered_task_for_terminal_job_is_a_safe_noop(self) -> None:
        registry = JobHandlerRegistry(); registry.register("bootstrap", lambda _j, _path: {"warnings": []})
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry)
        job = self.store.createAnalysisJob(CTX, make_input("bootstrap:redelivered"))["job"]
        first = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode())
        self.assertEqual(first.status, 204); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "done")
        redelivered = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode())
        self.assertEqual(redelivered.status, 204); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "done")
    def test_task_for_job_deleted_by_workspace_purge_is_acknowledged(self) -> None:
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker")
        response = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, b'{"workspaceId":"w","jobId":"deleted"}')
        self.assertEqual(response.status, 204)
    def test_project_deleted_between_precheck_and_transactional_claim_is_acknowledged(self) -> None:
        job = self.store.createAnalysisJob(CTX, make_input("bootstrap:delete-race"))["job"]
        original = self.store.updateAnalysisJobStatus
        def claim_after_delete(ctx, job_id, status, opts=None):
            if status == "running": self.db.put("projects", "p", {"id": "p", "ownerWorkspaceId": "w", "status": "archived", "deletedAt": datetime.now(UTC).isoformat()})
            return original(ctx, job_id, status, opts)
        self.store.updateAnalysisJobStatus = claim_after_delete  # type: ignore[method-assign]
        calls: list[int] = []; registry = JobHandlerRegistry(); registry.register("bootstrap", lambda _job, _path: calls.append(1) or {})
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry)
        body = ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode()
        self.assertEqual(runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, body).status, 204)
        self.assertEqual(calls, []); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "queued")
    def test_running_redelivery_backs_off_while_lease_is_fresh_and_recovers_once_stale(self) -> None:
        calls: list[int] = []
        def handler(_job: object, _path: Path) -> dict[str, object]:
            calls.append(1); return {"success": True}
        registry = JobHandlerRegistry(); registry.register("bootstrap", handler)
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, stale_running_lease=timedelta(minutes=15))
        job = self.store.createAnalysisJob(CTX, make_input("bootstrap:crash"))["job"]
        self.store.updateAnalysisJobStatus(CTX, job["id"], "running")
        # Cloud Run crashed mid-execution: the job is stuck "running" with no
        # terminal status ever recorded, and a redelivered Cloud Tasks request
        # arrives shortly after (lease still fresh).
        fresh = runtime.run_job("w", job["id"])
        self.assertEqual(fresh, "leased"); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "running"); self.assertEqual(calls, [])
        self.store.runTransaction(lambda tx: tx.update(self.store._ref("analysis_jobs", job["id"]), {"startedAt": (datetime.now(UTC) - timedelta(minutes=20)).isoformat()}))
        recovered = runtime.run_job("w", job["id"])
        self.assertEqual(recovered, "done"); self.assertEqual(self.store.get(CTX, "analysis_jobs", job["id"])["status"], "done"); self.assertEqual(calls, [1])

    def test_compile_lease_backpressure_does_not_consume_failure_attempts(self) -> None:
        def leased(_job: object, _path: Path) -> dict[str, object]:
            raise RuleStoreError("COMPILE_LEASED", 409)
        registry = JobHandlerRegistry(); registry.register("compile", leased)
        runtime = WorkerRuntime(self.store, FakeOidcVerifier(), "https://worker", registry, max_attempts=1)
        job = self.store.createAnalysisJob(CTX, {"type": "compile", "projectId": "p", "payload": {"repositoryId": "repo"}, "idempotencyKey": "compile:repo:lease", "requestId": "r"})["job"]
        body = ('{"workspaceId":"w","jobId":"' + job["id"] + '"}').encode()
        for _ in range(3):
            response = runtime.handle_http("POST", "/tasks/analysis-jobs", {"authorization": "Bearer valid"}, body)
            current = self.store.get(CTX, "analysis_jobs", job["id"])
            self.assertEqual(response.status, 503)
            self.assertEqual(current["status"], "failed")
            self.assertEqual(current["attempts"], 0)
if __name__ == "__main__": unittest.main()
