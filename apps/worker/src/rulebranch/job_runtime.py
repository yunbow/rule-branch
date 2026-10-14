"""Cloud Tasks HTTP receiver and generic analysis-job execution runtime."""
from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Protocol
from uuid import uuid4

from .contracts import LIMITS
from .execution_guard import ExecutionLost, execution_scope
from .rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError

DEFAULT_STALE_RUNNING_LEASE = timedelta(minutes=15)
DEFAULT_EXECUTION_TIMEOUT_SECONDS = 540
MAX_TASK_BODY_BYTES = 8 * 1024

class OidcVerifier(Protocol):
    def verify(self, token: str, audience: str) -> bool: ...

class GoogleOidcVerifier:
    """Production verifier; imports google-auth lazily and makes no call until used."""
    def __init__(self, expected_service_account_email: str) -> None:
        if not expected_service_account_email: raise ValueError("expected OIDC service account email is required")
        self.expected_service_account_email = expected_service_account_email
    def _claims_match(self, claims: Mapping[str, Any]) -> bool:
        return claims.get("email") == self.expected_service_account_email and claims.get("email_verified") is True
    def verify(self, token: str, audience: str) -> bool:
        from google.auth.transport.requests import Request
        from google.oauth2 import id_token
        try:
            claims = id_token.verify_oauth2_token(token, Request(), audience=audience)
            return self._claims_match(claims)
        except Exception: return False

@dataclass(frozen=True)
class HttpResponse: status: int; body: dict[str, Any]
JobHandler = Callable[[dict[str, Any], Path], dict[str, Any] | None]

class JobHandlerRegistry:
    def __init__(self) -> None: self._handlers: dict[str, JobHandler] = {}
    def register(self, type: str, handler: JobHandler) -> None: self._handlers[type] = handler
    def get(self, type: str) -> JobHandler | None: return self._handlers.get(type)
    def register_bootstrap(self, store: FirestoreRuleStore, generator: Any, model: str, injection_patterns: tuple[str, ...], auth: Any = None) -> None:
        """Register the production bootstrap handler with injected AI dependencies."""
        from .bootstrap import BootstrapJobHandler
        self.register("bootstrap", BootstrapJobHandler(store, generator, model, injection_patterns, auth))
    def register_compile(self, store: FirestoreRuleStore, publisher: Any) -> None:
        from .compile_job import CompileJobHandler
        self.register("compile", CompileJobHandler(store, publisher))
    def register_publish_verify(self, store: FirestoreRuleStore, git: Any) -> None:
        from .publish_verify import PublishVerifyJobHandler
        self.register("publish_verify", PublishVerifyJobHandler(store, git))
    def register_drift_scan(self, store: FirestoreRuleStore, generator: Any, model: str, auth: Any = None) -> None:
        from .drift import DriftScanJobHandler
        self.register("drift_scan", DriftScanJobHandler(store, generator, model, auth))
    def register_proposal(self, store: FirestoreRuleStore, generator: Any, model: str, auth: Any = None) -> None:
        from .proposal import ProposalJobHandler
        self.register("proposal", ProposalJobHandler(store, generator, model, auth))
    def register_purge(self, store: FirestoreRuleStore) -> None:
        from .purge import PurgeJobHandler
        self.register("purge", PurgeJobHandler(store))

class WorkerRuntime:
    def __init__(self, store: FirestoreRuleStore, verifier: OidcVerifier, audience: str, handlers: JobHandlerRegistry | None = None, max_attempts: int = int(LIMITS["analysisJobs"]["defaultMaxAttempts"]), tmp_root: Path = Path("/tmp"), stale_running_lease: timedelta = DEFAULT_STALE_RUNNING_LEASE, execution_timeout_seconds: float = DEFAULT_EXECUTION_TIMEOUT_SECONDS, hard_deadline: bool = False) -> None:
        if not 0 < execution_timeout_seconds < stale_running_lease.total_seconds():
            raise ValueError("Execution timeout must be positive and shorter than the stale lease")
        self.store, self.verifier, self.audience, self.handlers, self.max_attempts, self.tmp_root, self.stale_running_lease = store, verifier, audience, handlers or JobHandlerRegistry(), max_attempts, tmp_root, stale_running_lease
        self.execution_timeout_seconds, self.hard_deadline = execution_timeout_seconds, hard_deadline
        if self.handlers.get("purge") is None: self.handlers.register_purge(store)
    def handle_http(self, method: str, path: str, headers: dict[str, str], body: bytes) -> HttpResponse:
        if method != "POST" or path != "/tasks/analysis-jobs": return HttpResponse(404, {"error": "NOT_FOUND"})
        if len(body) > MAX_TASK_BODY_BYTES: return HttpResponse(413, {"error": "PAYLOAD_TOO_LARGE"})
        auth = headers.get("authorization", headers.get("Authorization", "")); token = auth[7:] if auth.startswith("Bearer ") else ""
        if not token: return HttpResponse(401, {"error": "UNAUTHENTICATED"})
        if not self.verifier.verify(token, self.audience): return HttpResponse(403, {"error": "FORBIDDEN"})
        try:
            event = json.loads(body)
            status = self.run_job(str(event["workspaceId"]), str(event["jobId"]))
            return HttpResponse(500 if status == "failed" else 503 if status == "leased" else 204, {})
        except (KeyError, ValueError, TypeError): return HttpResponse(400, {"error": "INVALID_TASK"})

    def run_job(self, workspace_id: str, job_id: str) -> Literal["done", "failed", "dead", "deleted", "leased"]:
        ctx = RuleStoreContext(workspace_id, None, "ai")
        job = self.store.get(ctx, "analysis_jobs", job_id)
        if job is None: return "deleted"
        if job.get("type") != "purge":
            project = self.store.get(ctx, "projects", str(job.get("projectId")))
            if project is None or project.get("deletedAt") or project.get("status") != "active": return "deleted"
        if job["status"] in ("done", "dead"): return job["status"]
        try:
            if job["status"] == "running":
                try:
                    started = datetime.fromisoformat(str(job.get("startedAt")))
                    if started.tzinfo is None: return "leased"
                except (ValueError, TypeError): return "leased"
                if datetime.now(UTC) - started < self.stale_running_lease: return "leased"
                # Compare the observed attempt in the recovery transaction. A
                # second delivery must not fail a successor claimed meanwhile.
                recovered = self.store.updateAnalysisJobStatus(ctx, job_id, "failed", {
                    "error": "stale running lease reclaimed", "maxAttempts": self.max_attempts,
                    "expectedExecutionOwner": job.get("executionOwner"), "expectedStartedAt": job.get("startedAt"),
                })
                if recovered["status"] == "dead": return "dead"
            job = self.store.updateAnalysisJobStatus(ctx, job_id, "running", {
                "maxAttempts": self.max_attempts, "executionOwner": uuid4().hex,
                "executionDeadline": (datetime.now(UTC) + timedelta(seconds=self.execution_timeout_seconds)).isoformat(),
            })
        except RuleStoreError as error:
            if error.code == "PROJECT_DELETED": return "deleted"
            if error.code in {"EXECUTION_CHANGED", "INVALID_STATUS_TRANSITION"}: return "leased"
            raise

        self.tmp_root.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="rulebranch-job-", dir=self.tmp_root))
        try:
            with execution_scope(self.store, job, hard_deadline=self.hard_deadline):
                return self._execute(ctx, job, directory)
        except ExecutionLost:
            # Do not write failed/done or consume the successor's attempt budget.
            return "leased"
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def _execute(self, ctx: RuleStoreContext, job: dict[str, Any], directory: Path) -> Literal["done", "failed", "dead", "deleted", "leased"]:
        job_id = str(job["id"])
        try:
            handler = self.handlers.get(str(job["type"]))
            if handler is None: raise RuntimeError(f"unregistered job type: {job['type']}")
            result = handler(job, directory) or {}; warnings = result.get("warnings", [])
            if self.store.get(ctx, "analysis_jobs", job_id) is None: return "deleted"
            if result.get("success", True):
                self.store.updateAnalysisJobStatus(ctx, job_id, "done", {"warnings": warnings, "maxAttempts": self.max_attempts})
                return "done"
            state = self.store.updateAnalysisJobStatus(ctx, job_id, "failed", {"error": result.get("error", "handler failed"), "warnings": warnings, "maxAttempts": self.max_attempts})
            return "dead" if state["status"] == "dead" else "failed"
        except ExecutionLost:
            raise
        except RuleStoreError as error:
            if self.store.get(ctx, "analysis_jobs", job_id) is None: return "deleted"
            if error.code == "COMPILE_LEASED" and job.get("type") == "compile":
                self.store.updateAnalysisJobStatus(ctx, job_id, "failed", {"error": error.code, "maxAttempts": self.max_attempts, "consumeAttempt": False})
                return "leased"
            state = self.store.updateAnalysisJobStatus(ctx, job_id, "failed", {"error": str(error), "maxAttempts": self.max_attempts})
            return "dead" if state["status"] == "dead" else "failed"
        except Exception as error:
            if self.store.get(ctx, "analysis_jobs", job_id) is None: return "deleted"
            state = self.store.updateAnalysisJobStatus(ctx, job_id, "failed", {"error": str(error), "maxAttempts": self.max_attempts})
            return "dead" if state["status"] == "dead" else "failed"
