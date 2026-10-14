"""Attempt ownership fences and an application-owned deadline.

Firestore fences protect database commits, not already accepted remote requests.
GitHub publication also requires a checked branch head and non-force recovery.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime
import os
from threading import Timer
from typing import Any, Iterator


class ExecutionLost(RuntimeError):
    """The caller must abandon this attempt without updating its successor."""


@dataclass(frozen=True)
class Attempt:
    store: Any
    workspace_id: str
    job_id: str
    owner: str
    deadline: datetime
    allow_deleted: bool = False


@dataclass(frozen=True)
class CompileOwner:
    store: Any
    workspace_id: str
    repository_id: str
    owner: str


_attempt: ContextVar[Attempt | None] = ContextVar("rulebranch_attempt", default=None)
_compile_owner: ContextVar[CompileOwner | None] = ContextVar("rulebranch_compile_owner", default=None)


def _date(value: Any) -> datetime:
    try:
        date = datetime.fromisoformat(str(value))
        if date.tzinfo is None:
            raise ValueError("timezone required")
        return date
    except (ValueError, TypeError) as error:
        raise ExecutionLost("Invalid execution deadline") from error


def check_deadline() -> None:
    attempt = _attempt.get()
    if attempt is not None and datetime.now(UTC) >= attempt.deadline:
        raise ExecutionLost("Execution deadline exceeded")


def assert_current_execution(store: Any, tx: Any = None) -> None:
    """Read fence documents before any transaction writes (including retries)."""
    check_deadline()
    def read(collection: str, identifier: str) -> dict[str, Any] | None:
        ref = store._ref(collection, identifier)
        return (tx.get(ref) if tx is not None else ref.get()).to_dict()

    attempt = _attempt.get()
    if attempt is not None and attempt.store is store:
        job = read("analysis_jobs", attempt.job_id)
        if job is None and attempt.allow_deleted:
            pass  # purge may deliberately delete its own job; the time fence remains.
        elif (job is None or job.get("ownerWorkspaceId") != attempt.workspace_id
              or job.get("status") != "running"
              or job.get("executionOwner") != attempt.owner
              or _date(job.get("executionDeadline")) != attempt.deadline):
            raise ExecutionLost("Execution owner changed")

    owner = _compile_owner.get()
    if owner is not None and owner.store is store:
        repository = read("repositories", owner.repository_id)
        lease = (repository or {}).get("compileLease") or {}
        if (not repository or repository.get("ownerWorkspaceId") != owner.workspace_id
                or repository.get("status") != "active" or repository.get("deletedAt")
                or lease.get("owner") != owner.owner
                or _date(lease.get("expiresAt")) <= datetime.now(UTC)):
            raise ExecutionLost("Compile lease lost")
    check_deadline()


def checkpoint() -> None:
    """Recheck ownership immediately before an external side effect."""
    check_deadline()
    attempt, owner = _attempt.get(), _compile_owner.get()
    stores = [item.store for item in (attempt, owner) if item is not None]
    seen: set[int] = set()
    for store in stores:
        if id(store) not in seen:
            assert_current_execution(store)
            seen.add(id(store))


@contextmanager
def execution_scope(store: Any, job: dict[str, Any], *, hard_deadline: bool = False) -> Iterator[None]:
    deadline = _date(job.get("executionDeadline"))
    owner = job.get("executionOwner")
    if not isinstance(owner, str) or not owner:
        raise ExecutionLost("Execution owner missing")
    token = _attempt.set(Attempt(store, str(job["ownerWorkspaceId"]), str(job["id"]),
                                 owner, deadline, job.get("type") == "purge"))
    watchdog = None
    try:
        check_deadline()
        if hard_deadline:
            # Cloud Run's HTTP timeout does not stop application code.  A process
            # exit is deliberate here: production Worker concurrency is one and
            # durable job state is recovered by a later delivery. No finally
            # block can allow this attempt to resume after os._exit.
            watchdog = Timer(max(0.0, (deadline - datetime.now(UTC)).total_seconds()), os._exit, args=(124,))
            watchdog.daemon = True
            watchdog.start()
        yield
    finally:
        if watchdog is not None:
            watchdog.cancel()
        _attempt.reset(token)


@contextmanager
def compile_ownership(store: Any, workspace_id: str, repository_id: str, owner: str) -> Iterator[None]:
    token = _compile_owner.set(CompileOwner(store, workspace_id, repository_id, owner))
    try:
        checkpoint()
        yield
    finally:
        _compile_owner.reset(token)
