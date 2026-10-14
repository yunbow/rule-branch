"""Firestore RuleStore foundation (DM 2.6, 5.22, 5.27, and 10.3).

The production class accepts an injected ``google.cloud.firestore.Client``.  It
does not create a client, so importing this module never opens a GCP connection.
Domain methods intentionally remain outside IMPL-002.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256 as sha256_digest
import json
from typing import Any, Callable, Protocol, TypeVar
import re
from fnmatch import fnmatchcase

from .contracts import ENUMS, LIMITS
from .execution_guard import assert_current_execution, check_deadline
from .relation_scope import uncovered_relation_fields
from .ulid import generate_ulid

DocumentData = dict[str, Any]
T = TypeVar("T")


@dataclass(frozen=True)
class RuleStoreContext:
    workspaceId: str
    actorUserId: str | None
    actorKind: str | None = None


class DocumentSnapshotLike(Protocol):
    exists: bool
    id: str

    def to_dict(self) -> DocumentData | None: ...


class DocumentReferenceLike(Protocol):
    id: str

    def get(self, **kwargs: Any) -> DocumentSnapshotLike: ...


class TransactionLike(Protocol):
    def get(self, ref: DocumentReferenceLike) -> DocumentSnapshotLike: ...
    def query(self, collection: str, filters: DocumentData, limit: int | None = None) -> list[DocumentSnapshotLike]: ...
    def create(self, ref: DocumentReferenceLike, data: DocumentData) -> Any: ...
    def update(self, ref: DocumentReferenceLike, data: DocumentData) -> Any: ...
    def delete(self, ref: DocumentReferenceLike) -> Any: ...


class RuleStore(Protocol):
    def get(self, ctx: RuleStoreContext, collection: str, id: str) -> DocumentData | None: ...
    def list(self, ctx: RuleStoreContext, collection: str, filter: DocumentData | None = None) -> list[DocumentData]: ...
    def reserveUniqueKey(self, tx: TransactionLike, kind: str, components: dict[str, str], target: DocumentData) -> None: ...
    def releaseUniqueKey(self, tx: TransactionLike, kind: str, components: dict[str, str]) -> None: ...
    def runTransaction(self, callback: Callable[[TransactionLike], T]) -> T: ...
    def appendAuditLog(self, ctx: RuleStoreContext, entry: DocumentData, tx: TransactionLike | None = None) -> None: ...
    def redactAuditLogPayloads(self, ctx: RuleStoreContext, filter: DocumentData) -> DocumentData: ...
    def purgeWorkspace(self, ctx: RuleStoreContext, workspaceId: str, preserveJobId: str | None = None) -> DocumentData: ...
    def createAnalysisJob(self, ctx: RuleStoreContext, input: DocumentData) -> DocumentData: ...
    def updateAnalysisJobStatus(self, ctx: RuleStoreContext, jobId: str, status: str, opts: DocumentData | None = None) -> DocumentData: ...
    def createBootstrapBatch(self, ctx: RuleStoreContext, projectId: str, candidates: list[DocumentData]) -> list[DocumentData]: ...
    def createDriftScanBatch(self, ctx: RuleStoreContext, triggerId: str, findings: list[DocumentData]) -> list[DocumentData]: ...
    def writeCompiledArtifacts(self, ctx: RuleStoreContext, artifacts: list[DocumentData]) -> None: ...
    def openRevisionPr(self, ctx: RuleStoreContext, input: DocumentData) -> DocumentData: ...
    def recordPublishVerification(self, ctx: RuleStoreContext, revisionPrId: str, result: DocumentData) -> None: ...


class RuleStoreError(Exception):
    def __init__(self, code: str, status: int, details: DocumentData | None = None) -> None:
        super().__init__(code)
        self.code, self.status, self.details = code, status, details or {}


ANALYSIS_JOB_TYPES = frozenset(ENUMS["analysis_jobs.type"])
_KEY_PARTS = {type: set(parts) for type, parts in LIMITS["analysisJobs"]["idempotencyKeyParts"].items()}
UNINSTALL_TOMBSTONE_TABLES = tuple(LIMITS["uninstall"]["tombstoneTables"])

# Firestore caps a Commit/transaction request at 10 MiB.  Keep a sizeable
# margin for protobuf field names, document paths and transaction metadata;
# canonical JSON is only a conservative, portable approximation of the wire
# representation used by the production client.
MAX_COMPILED_ARTIFACT_BATCH_BYTES = 8 * 1024 * 1024
COMPILED_ARTIFACT_WRITE_OVERHEAD_BYTES = 1024


UNIQUE_KEY_KINDS = tuple(ENUMS["unique_keys.kind"])
_GLOBAL_KINDS = {"github_user", "user_preference", "github_org", "github_installation", "github_repo"}
_COMPONENTS = {
    "github_user": ("githubUserId",), "user_preference": ("userId",), "github_org": ("githubOrgId",),
    "github_installation": ("githubInstallationId",), "github_repo": ("githubRepoId",),
    "workspace_member": ("workspaceId", "userId"),
    "workspace_invitation_pending": ("workspaceId", "invitedGithubUserId"),
    "project_slug": ("ownerWorkspaceId", "slug"), "rule_key": ("ownerWorkspaceId", "scopeType", "scopeId", "key"),
    "rule_relation_child": ("childRuleId",), "revision_pr_open": ("repositoryId",),
    "job_idempotency": ("idempotencyKeyHash",),
}

# This manifest is checked against TypeScript in tests.  CamelCase is intentional (DM 10.3).
RULE_STORE_METHOD_SIGNATURES = (
    ("get", "ctx,collection,id"), ("list", "ctx,collection,filter"), ("reserveUniqueKey", "tx,kind,components,target"), ("releaseUniqueKey", "tx,kind,components"), ("runTransaction", "callback"),
    ("appendAuditLog", "ctx,entry,tx"), ("redactAuditLogPayloads", "ctx,filter"),
    ("linkRepository", "ctx,input"), ("getRule", "ctx,ruleId"), ("listRules", "ctx,filter"), ("createRule", "ctx,input"), ("updateRuleStatus", "ctx,ruleId,status,opts"),
    ("createRuleVersion", "ctx,ruleId,input"), ("approveRuleVersion", "ctx,ruleVersionId,approvedBy"), ("rejectRuleVersion", "ctx,ruleVersionId,reason"), ("withdrawRuleVersion", "ctx,ruleVersionId,opts"), ("listRuleVersions", "ctx,ruleId"), ("getPublicationState", "ctx,ruleVersionId"),
    ("createRelation", "ctx,input"), ("resolveRules", "ctx,projectId,repositoryId,userId,selector"), ("recordProvenance", "ctx,entries"), ("createDriftFinding", "ctx,input"), ("updateDriftFinding", "ctx,driftFindingId,patch"), ("createTrigger", "ctx,input"), ("listImpact", "ctx,ruleVersionId"),
    ("listMembers", "ctx,workspaceId"), ("addMember", "ctx,input"), ("updateMemberRole", "ctx,memberId,role"), ("removeMember", "ctx,memberId"), ("createInvitation", "ctx,input"), ("listInvitations", "ctx,filter"), ("updateInvitationStatus", "ctx,invitationId,status,actorUserId"),
    ("purgeWorkspace", "ctx,workspaceId,preserveJobId"), ("createAnalysisJob", "ctx,input"), ("updateAnalysisJobStatus", "ctx,jobId,status,opts"), ("createBootstrapBatch", "ctx,projectId,candidates"), ("createDriftScanBatch", "ctx,triggerId,findings"), ("openRevisionPr", "ctx,input"), ("updateRevisionPrStatus", "ctx,revisionPrId,status,opts"), ("recordPublishVerification", "ctx,revisionPrId,result"),
)


def uniqueKeyId(kind: str, components: dict[str, str]) -> str:
    if kind not in _COMPONENTS:
        raise ValueError(f"Unknown unique key kind: {kind}")
    values: list[str] = []
    for name in _COMPONENTS[kind]:
        value = components.get(name)
        if not value or "/" in value:
            raise ValueError(f"Invalid {kind} component: {name}")
        values.append(value)
    return f"{kind}:{':'.join(values)}"


def canonicalJson(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _compiled_artifact_write_size(value: DocumentData) -> int:
    return len(canonicalJson(value).encode("utf-8")) + len(str(value.get("id", "")).encode("utf-8")) + COMPILED_ARTIFACT_WRITE_OVERHEAD_BYTES


def _compiled_artifact_batches(artifacts: list[DocumentData]) -> list[list[DocumentData]]:
    maximum_writes = int(LIMITS["limits"]["maxTransactionWrites"])
    batches: list[list[DocumentData]] = []
    batch: list[DocumentData] = []
    batch_bytes = 0
    for artifact in artifacts:
        write_bytes = _compiled_artifact_write_size(artifact)
        if write_bytes > MAX_COMPILED_ARTIFACT_BATCH_BYTES:
            raise RuleStoreError("ARTIFACT_TOO_LARGE", 422, {"id": artifact.get("id"), "estimatedBytes": write_bytes})
        if batch and (len(batch) >= maximum_writes or batch_bytes + write_bytes > MAX_COMPILED_ARTIFACT_BATCH_BYTES):
            batches.append(batch)
            batch, batch_bytes = [], 0
        batch.append(artifact)
        batch_bytes += write_bytes
    if batch:
        batches.append(batch)
    return batches


def sha256(value: Any) -> str:
    return sha256_digest(canonicalJson(value).encode()).hexdigest()


def sha256HexString(value: str) -> str:
    """Hash raw UTF-8 text, as required for Cloud Tasks and job_idempotency."""
    return sha256_digest(value.encode("utf-8")).hexdigest()


def _truncate_payload(value: Any) -> Any:
    if value is None:
        return None
    return {"_truncated": True, "sha256": sha256(value)} if len(canonicalJson(value).encode()) > 32 * 1024 else value


def requireHumanActor(ctx: RuleStoreContext, operation: str, status: str | None = None) -> None:
    member_operations = {"addMember", "updateMemberRole", "removeMember", "createInvitation", "listInvitations", "updateInvitationStatus", "listMembers"}
    protected = operation in {"approveRuleVersion", "triageDriftFinding"} or operation in member_operations or (operation == "updateRuleStatus" and status in {"deprecated", "superseded", "archived"})
    if protected and ctx.actorUserId is None:
        raise RuleStoreError("FORBIDDEN", 403, {"operation": operation})


def withHumanActorGuard(operation: str, function: Callable[..., T]) -> Callable[..., T]:
    def guarded(ctx: RuleStoreContext, *args: Any, **kwargs: Any) -> T:
        requireHumanActor(ctx, operation, str(args[1]) if operation == "updateRuleStatus" and len(args) > 1 else None)
        return function(ctx, *args, **kwargs)
    return guarded


class _CountingTransaction:
    def __init__(self, transaction: TransactionLike, firestore: Any = None) -> None:
        self._transaction, self._firestore, self.writes = transaction, firestore, 0

    def get(self, ref: DocumentReferenceLike) -> DocumentSnapshotLike:
        if self.writes:
            raise RuntimeError("Firestore transactions require all reads before writes")
        result = self._transaction.get(ref)
        # google-cloud-firestore's production Transaction.get(DocumentReference)
        # returns an iterator, while the narrow test adapter returns a snapshot.
        # Keep the RuleStore-facing contract snapshot-shaped in both cases.
        if hasattr(result, "exists") and hasattr(result, "to_dict"):
            return result
        try:
            snapshot = next(iter(result))
        except (StopIteration, TypeError) as error:
            raise RuntimeError("Transaction.get did not return a document snapshot") from error
        if not hasattr(snapshot, "exists") or not hasattr(snapshot, "to_dict"):
            raise RuntimeError("Transaction.get did not return a document snapshot")
        return snapshot

    def query(self, collection: str, filters: DocumentData, limit: int | None = None) -> list[DocumentSnapshotLike]:
        if self.writes:
            raise RuntimeError("Firestore transactions require all reads before writes")
        if self._firestore is None:
            raise RuntimeError("Firestore query adapter is unavailable")
        query = self._firestore.collection(collection)
        for field, value in filters.items(): query = query.where(field, "==", value)
        if limit is not None: query = query.limit(limit)
        return list(self._transaction.get(query))

    def _count(self) -> None:
        check_deadline()
        self.writes += 1
        maximum = int(LIMITS["limits"]["maxTransactionWrites"])
        if self.writes > maximum:
            raise RuleStoreError("TRANSACTION_WRITE_LIMIT", 400, {"maxTransactionWrites": maximum})

    def create(self, ref: DocumentReferenceLike, data: DocumentData) -> Any:
        self._count(); return self._transaction.create(ref, data)
    def update(self, ref: DocumentReferenceLike, data: DocumentData) -> Any:
        self._count(); return self._transaction.update(ref, data)
    def delete(self, ref: DocumentReferenceLike) -> Any:
        self._count(); return self._transaction.delete(ref)


class FirestoreRuleStore:
    """Production adapter for an injected ``google.cloud.firestore.Client``."""
    def __init__(self, firestore: Any) -> None:
        self._firestore = firestore

    def _ref(self, collection: str, id: str) -> Any:
        return self._firestore.collection(collection).document(id)

    def runTransaction(self, callback: Callable[[TransactionLike], T]) -> T:
        # Fence reads participate in the SAME transaction as domain writes.
        # A successor claim therefore invalidates an old attempt's transaction.
        def guarded(native: Any) -> T:
            tx = _CountingTransaction(native, self._firestore)
            assert_current_execution(self, tx)
            result = callback(tx)
            check_deadline()
            return result
        if hasattr(self._firestore, "run_transaction"):
            return self._firestore.run_transaction(guarded)
        # google-cloud-firestore's transactional decorator retries optimistic conflicts.
        transaction = self._firestore.transaction()
        from google.cloud.firestore_v1 import transactional  # dependency declared in pyproject; lazy to keep imports side-effect free
        @transactional
        def execute(native_transaction: Any) -> T:
            return guarded(native_transaction)
        return execute(transaction)

    @staticmethod
    def _data(snapshot: Any) -> DocumentData | None:
        return snapshot.to_dict() if snapshot.exists else None

    def get(self, ctx: RuleStoreContext, collection: str, id: str) -> DocumentData | None:
        data = self._data(self._ref(collection, id).get())
        if data is None or (data.get("ownerWorkspaceId") != ctx.workspaceId and not (collection == "unique_keys" and data.get("ownerWorkspaceId") is None)):
            return None
        return data

    def _get_many(self, ctx: RuleStoreContext, collection: str, ids: list[str]) -> list[DocumentData]:
        """Read a set of documents in one Firestore RPC while preserving id order."""
        unique_ids = list(dict.fromkeys(ids))
        if not unique_ids:
            return []
        refs = [self._ref(collection, id) for id in unique_ids]
        if hasattr(self._firestore, "get_all"):
            snapshots = self._firestore.get_all(refs)
        else:
            # Test doubles and narrow adapters may only implement Reference.get().
            snapshots = (ref.get() for ref in refs)
        values: dict[str, DocumentData] = {}
        for snapshot in snapshots:
            data = self._data(snapshot)
            if data is not None and data.get("ownerWorkspaceId") == ctx.workspaceId:
                values[str(snapshot.id)] = data
        return [values[id] for id in ids if id in values]

    def list(self, ctx: RuleStoreContext, collection: str, filter: DocumentData | None = None) -> list[DocumentData]:
        def query(owner: str | None) -> list[DocumentData]:
            result = self._firestore.collection(collection).where("ownerWorkspaceId", "==", owner)
            for field, value in (filter or {}).items(): result = result.where(field, "==", value)
            return [snapshot.to_dict() for snapshot in result.stream()]
        return query(ctx.workspaceId) + (query(None) if collection == "unique_keys" else [])

    def reserveUniqueKey(self, tx: TransactionLike, kind: str, components: dict[str, str], target: DocumentData) -> None:
        id = uniqueKeyId(kind, components); ref = self._ref("unique_keys", id); existing = tx.get(ref)
        self._reserve_unique_key(tx, kind, components, target, existing)

    def _reserve_unique_key(self, tx: TransactionLike, kind: str, components: dict[str, str], target: DocumentData, existing: DocumentSnapshotLike) -> None:
        id = uniqueKeyId(kind, components); ref = self._ref("unique_keys", id)
        if existing.exists: raise RuleStoreError("UNIQUE_VIOLATION", 409, {"kind": kind, "value": id[len(kind) + 1:]})
        owner_workspace_id = None if kind in _GLOBAL_KINDS else components.get("ownerWorkspaceId", components.get("workspaceId"))
        if kind not in _GLOBAL_KINDS and not owner_workspace_id: raise ValueError(f"ownerWorkspaceId is required for {kind}")
        tx.create(ref, {"id": id, "kind": kind, "ownerWorkspaceId": owner_workspace_id, "targetTable": target["targetTable"], "targetId": target["targetId"], "createdAt": datetime.now(UTC).isoformat()})

    def releaseUniqueKey(self, tx: TransactionLike, kind: str, components: dict[str, str]) -> None:
        ref = self._ref("unique_keys", uniqueKeyId(kind, components))
        if tx.get(ref).exists: tx.delete(ref)

    def appendAuditLog(self, ctx: RuleStoreContext, entry: DocumentData, tx: TransactionLike | None = None) -> None:
        if not entry.get("requestId"): raise ValueError("audit requestId is required")
        before, after = entry.get("before"), entry.get("after")
        id = generate_ulid(); data: DocumentData = {"id": id, "ownerWorkspaceId": ctx.workspaceId, "actor": entry["actor"], "action": entry["action"], "targetType": entry["targetType"], "targetId": entry["targetId"], "before": _truncate_payload(before), "after": _truncate_payload(after), "ip": entry.get("ip"), "requestId": entry["requestId"], "occurredAt": entry.get("occurredAt", datetime.now(UTC).isoformat()), "retentionClass": "audit", "payloadHash": sha256({"before": before, "after": after}), "payloadRedactedAt": None}
        if tx is not None: tx.create(self._ref("audit_logs", id), data)
        else: self.runTransaction(lambda transaction: transaction.create(self._ref("audit_logs", id), data))

    def redactAuditLogPayloads(self, ctx: RuleStoreContext, filter: DocumentData) -> DocumentData:
        if ctx.actorKind != "system": raise RuleStoreError("FORBIDDEN", 403, {"operation": "redactAuditLogPayloads"})
        workspace_id = str(filter.get("workspaceId", ctx.workspaceId))
        if workspace_id != ctx.workspaceId: raise RuleStoreError("FORBIDDEN", 403, {"operation": "redactAuditLogPayloads"})
        logs = self._server_list("audit_logs", {"ownerWorkspaceId": workspace_id}); now = datetime.now(UTC).isoformat(); count = 0
        for log in logs:
            if log.get("payloadRedactedAt") is not None: continue
            def redact(tx: TransactionLike, id: str = str(log["id"])) -> bool:
                snapshot = tx.get(self._ref("audit_logs", id))
                if not snapshot.exists or (snapshot.to_dict() or {}).get("payloadRedactedAt") is not None: return False
                tx.update(self._ref("audit_logs", id), {"before": None, "after": None, "payloadRedactedAt": now}); return True
            if self.runTransaction(redact): count += 1
        return {"count": count}

    def _server_list(self, collection: str, filter: DocumentData | None = None) -> list[DocumentData]:
        query = self._firestore.collection(collection)
        if not filter and hasattr(query, "stream"):
            values = (item.to_dict() for item in query.stream() if item.exists)
            return [value for value in values if value is not None]
        # The in-memory Firestore double intentionally exposes only Query.stream.
        # This fallback is never used by the production adapter.
        if not filter and hasattr(self._firestore, "records"):
            return [dict(data) for (name, _), (data, _) in self._firestore.records.items() if name == collection]
        for field, value in (filter or {}).items(): query = query.where(field, "==", value)
        values = (item.to_dict() for item in query.stream() if item.exists)
        return [value for value in values if value is not None]

    def _delete_if_exists(self, tx: TransactionLike, collection: str, id: str) -> int:
        ref = self._ref(collection, id)
        if not tx.get(ref).exists: return 0
        tx.delete(ref); return 1

    def purgeWorkspace(self, ctx: RuleStoreContext, workspaceId: str, preserveJobId: str | None = None) -> DocumentData:
        """Physical UC-06 purge with transactionally paired GitHub key releases.

        A crashed purge may be retried after deleting a Repository/Installation.
        Its global unique key must disappear in the SAME transaction: once the
        target document is gone, a retry cannot infer its former Workspace.
        preserveJobId retains the executing purge job for normal completion.
        """
        if ctx.actorKind != "system" or ctx.workspaceId != workspaceId:
            raise RuleStoreError("FORBIDDEN", 403, {"operation": "purgeWorkspace"})

        # Establish a durable creation fence before enumerating any targets.
        # A reinstall which committed first cancels an organization purge; once
        # this marker exists, retries resume even if a later install is active.
        def begin_purge(tx: TransactionLike) -> bool:
            workspace_ref = self._ref("workspaces", workspaceId)
            snapshot = tx.get(workspace_ref)
            workspace = snapshot.to_dict()
            if not snapshot.exists or not workspace:
                return True
            if workspace.get("purgeStartedAt"):
                return True
            if workspace.get("kind") == "organization" and tx.query("installations", {
                    "ownerWorkspaceId": workspaceId, "status": "active"}, limit=1):
                return False
            tx.update(workspace_ref, {"purgeStartedAt": datetime.now(UTC).isoformat()})
            return True
        if not self.runTransaction(begin_purge):
            return {"deletedCount": 0, "redactedCount": 0, "cancelled": True}

        tables = (*UNINSTALL_TOMBSTONE_TABLES, "rule_relations", "change_triggers",
                  "resolution_snapshots", "revision_prs", "analysis_jobs")
        unique_keys = self._server_list("unique_keys")
        keys_by_target: dict[tuple[str, str], list[DocumentData]] = {}
        for key in unique_keys:
            if key.get("kind") not in {"github_org", "github_installation", "github_repo"}:
                continue
            table, target = key.get("targetTable"), key.get("targetId")
            if isinstance(table, str) and isinstance(target, str):
                keys_by_target.setdefault((table, target), []).append(key)

        def delete_owned(collection: str, records: list[DocumentData], ownership_field: str) -> int:
            # Bound all writes INCLUDING global key releases, not only documents.
            parts: list[list[DocumentData]] = []
            part: list[DocumentData] = []
            expected_writes = 0
            for record in records:
                weight = 1 + len(keys_by_target.get((collection, str(record["id"])), []))
                if part and expected_writes + weight > 400:
                    parts.append(part)
                    part, expected_writes = [], 0
                part.append(record)
                expected_writes += weight
            if part:
                parts.append(part)
            count = 0
            for batch in parts:
                def delete_batch(tx: TransactionLike, items: list[DocumentData] = batch) -> int:
                    # Firestore requires every read before the first write.
                    plan: list[tuple[Any, Any, list[tuple[Any, Any]]]] = []
                    for item in items:
                        doc_id = str(item["id"])
                        doc_ref = self._ref(collection, doc_id)
                        snapshot = tx.get(doc_ref)
                        keys = []
                        for key in keys_by_target.get((collection, doc_id), []):
                            key_ref = self._ref("unique_keys", str(key["id"]))
                            keys.append((key_ref, tx.get(key_ref)))
                        plan.append((doc_ref, snapshot, keys))
                    deleted = 0
                    for doc_ref, snapshot, keys in plan:
                        value = snapshot.to_dict()
                        if not snapshot.exists or not value or value.get(ownership_field) != workspaceId:
                            continue
                        tx.delete(doc_ref)
                        deleted += 1
                        for key_ref, key_snapshot in keys:
                            current_key = key_snapshot.to_dict()
                            if (key_snapshot.exists and current_key
                                    and current_key.get("targetTable") == collection
                                    and str(current_key.get("targetId")) == doc_ref.id
                                    and current_key.get("kind") in {"github_org", "github_installation", "github_repo"}):
                                tx.delete(key_ref)
                    return deleted
                count += self.runTransaction(delete_batch)
            return count

        removed = 0
        for table in tables:
            records = self._server_list(table, {"ownerWorkspaceId": workspaceId})
            if table == "analysis_jobs" and preserveJobId is not None:
                records = [record for record in records if str(record["id"]) != preserveJobId]
            removed += delete_owned(table, records, "ownerWorkspaceId")
        for table in ("workspace_members", "workspace_invitations", "installations"):
            ownership_field = "workspaceId" if table.startswith("workspace_") else "ownerWorkspaceId"
            records = self._server_list(table, {ownership_field: workspaceId})
            removed += delete_owned(table, records, ownership_field)

        # Locally scoped reservations have ownerWorkspaceId on the key itself.
        # Global reservations must NOT be released here after their target vanished.
        for key in unique_keys:
            if key.get("ownerWorkspaceId") == workspaceId:
                self.runTransaction(lambda tx, id=str(key["id"]):
                                    self._delete_if_exists(tx, "unique_keys", id))

        workspace = self._ref("workspaces", workspaceId).get().to_dict()
        if workspace and workspace.get("kind") == "organization":
            def delete_workspace(tx: TransactionLike) -> None:
                ref = self._ref("workspaces", workspaceId)
                snapshot = tx.get(ref)
                keys = []
                for key in keys_by_target.get(("workspaces", workspaceId), []):
                    key_ref = self._ref("unique_keys", str(key["id"]))
                    keys.append((key_ref, tx.get(key_ref)))
                current = snapshot.to_dict()
                if not snapshot.exists or not current or current.get("kind") != "organization":
                    return
                tx.delete(ref)
                for key_ref, key_snapshot in keys:
                    key = key_snapshot.to_dict()
                    if (key_snapshot.exists and key and key.get("targetTable") == "workspaces"
                            and str(key.get("targetId")) == workspaceId
                            and key.get("kind") in {"github_org", "github_installation", "github_repo"}):
                        tx.delete(key_ref)
            self.runTransaction(delete_workspace)
        if removed:
            self.appendAuditLog(ctx, {"actor": {"kind": "system", "id": "purge"},
                "action": "data.purge", "targetType": "workspaces", "targetId": workspaceId,
                "requestId": f"purge:{workspaceId}", "after": {"deletedCount": removed}})
        redacted = self.redactAuditLogPayloads(ctx, {"workspaceId": workspaceId})["count"]
        return {"deletedCount": removed, "redactedCount": redacted}

    def createRuleVersion(self, ctx: RuleStoreContext, ruleId: str, input: DocumentData) -> DocumentData:
        """DM 10.5.3 version allocation.  The rule read/update forces retry on races."""
        _validate_rule_version_input(input)
        findings = self.list(ctx, "drift_findings", {"proposalVersionId": input["supersedes"]})[:20] if input.get("supersedes") else []
        def create(tx: TransactionLike) -> DocumentData:
            rule_ref = self._ref("rules", ruleId); snapshot = tx.get(rule_ref); rule = snapshot.to_dict()
            if not snapshot.exists or rule is None or rule.get("ownerWorkspaceId") != ctx.workspaceId: raise RuleStoreError("NOT_FOUND", 404)
            if rule.get("status") in {"superseded", "deprecated"}: raise RuleStoreError("RULE_STATUS_INVALID", 422)
            if ("expectedCurrentVersionId" in input
                    and rule.get("currentVersionId") != input.get("expectedCurrentVersionId")):
                raise RuleStoreError("RULE_VERSION_CHANGED", 409)
            proposal_finding: DocumentData | None = None
            if input.get("proposalFindingId"):
                proposal_snapshot = tx.get(self._ref("drift_findings", str(input["proposalFindingId"])))
                proposal_finding = proposal_snapshot.to_dict()
                if (not proposal_snapshot.exists or proposal_finding is None
                        or proposal_finding.get("ownerWorkspaceId") != ctx.workspaceId
                        or proposal_finding.get("ruleId") != ruleId):
                    raise RuleStoreError("NOT_FOUND", 404)
                if (proposal_finding.get("status") != "accepted"
                        or proposal_finding.get("ruleVersionId") != rule.get("currentVersionId")):
                    raise RuleStoreError("DRIFT_FINDING_OBSOLETE", 409)
            previous: DocumentData | None = None
            if input.get("supersedes"):
                previous_snapshot = tx.get(self._ref("rule_versions", str(input["supersedes"]))); previous = previous_snapshot.to_dict()
                if not previous_snapshot.exists or previous is None or previous.get("ruleId") != ruleId or previous.get("status") != "proposed": raise RuleStoreError("SUPERSEDES_INVALID", 422)
            current_findings = []
            if previous is not None:
                current_findings = [tx.get(self._ref("drift_findings", str(finding["id"]))) for finding in findings]
            provenance = input.get("provenance", rule.get("provenance", {}))
            if isinstance(provenance, dict) and provenance.get("sourceType") == "ai" and not input.get("evidenceIds", []): raise RuleStoreError("EVIDENCE_REQUIRED", 422)
            version = rule.get("nextVersion")
            if not isinstance(version, int) or version < 1: raise RuleStoreError("INVALID_NEXT_VERSION", 409)
            id, now = generate_ulid(), datetime.now(UTC).isoformat()
            value: DocumentData = {"id": id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": rule.get("scopeType"), "scopeId": rule.get("scopeId"), "visibility": rule.get("visibility"), "enforcement": rule.get("enforcement"), "transferPolicy": rule.get("transferPolicy"), "licenseType": rule.get("licenseType"), "provenance": provenance, "containsPersonalData": rule.get("containsPersonalData", False), "containsConfidentialData": rule.get("containsConfidentialData", False), "retentionClass": rule.get("retentionClass", "standard"), "createdBy": {"kind": ctx.actorKind or "user", "id": ctx.actorUserId or "system"}, "createdAt": now, "updatedAt": now, "deletedAt": None, "ruleId": ruleId, "version": version, "content": input["content"], "rationale": input["rationale"], "evidenceIds": input.get("evidenceIds", []), "compatibility": input.get("compatibility", {"frameworks": {}, "languages": {}, "tools": {}}), "changeType": input["changeType"], "triggerId": input.get("triggerId"), "driftFindingIds": input.get("driftFindingIds", []), "supersedes": input.get("supersedes"), "status": "proposed", "approvedBy": None, "approvedAt": None, "rejectionReason": None, "effectiveFrom": None, "effectiveTo": None, "aiSummary": input.get("aiSummary"), "truncation": None}
            for evidence in input.get("evidence", []):
                evidence_id = str(evidence["id"])
                tx.create(self._ref("evidence", evidence_id), {**evidence, "id": evidence_id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": rule.get("scopeType"), "scopeId": rule.get("scopeId"), "provenance": provenance, "createdBy": {"kind": "ai", "id": "worker"}, "createdAt": now, "updatedAt": now, "deletedAt": None, "retentionClass": "evidence"})
            tx.create(self._ref("rule_versions", id), value); tx.update(rule_ref, {"nextVersion": version + 1, "updatedAt": now})
            if previous is not None:
                tx.update(self._ref("rule_versions", str(previous["id"])), {"status": "withdrawn", "updatedAt": now})
                for finding, current in zip(findings, current_findings):
                    if current.exists and current.to_dict().get("proposalVersionId") == previous["id"]: tx.update(self._ref("drift_findings", str(finding["id"])), {"proposalVersionId": id, "updatedAt": now})
            if proposal_finding is not None:
                # D8 leaves accepted/open lifecycle state untouched: only the pointer changes.
                tx.update(self._ref("drift_findings", str(proposal_finding["id"])), {"proposalVersionId": id, "updatedAt": now})
            actor = {"kind": ctx.actorKind or "user", "id": ctx.actorUserId or "system"}
            self.appendAuditLog(ctx, {"actor": actor, "action": "rule_version.propose" if proposal_finding is not None else "rule_version.create", "targetType": "rule_versions", "targetId": id, "requestId": input.get("requestId", f"rule-version:{id}"), "after": {"ruleVersionId": id, "version": version}}, tx)
            if previous is not None: self.appendAuditLog(ctx, {"actor": actor, "action": "rule_version.withdraw", "targetType": "rule_versions", "targetId": previous["id"], "requestId": input.get("requestId", f"rule-version:{id}"), "before": {"status": "proposed"}, "after": {"status": "withdrawn", "supersededBy": id}}, tx)
            return value
        return self.runTransaction(create)

    def resolveRules(self, ctx: RuleStoreContext, projectId: str, repositoryId: str, userId: str | None = None, selector: DocumentData | None = None) -> DocumentData:
        """DM 8.1/8.2 resolver.  This is intentionally the sole implementation (K2)."""
        project = self.get(ctx, "projects", projectId)
        repository = self.get(ctx, "repositories", repositoryId)
        if project is None or repository is None or repository.get("projectId") != projectId:
            raise RuleStoreError("NOT_FOUND", 404)
        if repository.get("status") == "removed":
            return self._resolve_rules(ctx, projectId, repositoryId, userId, selector, project, repository, [], [])
        rules = self.list(ctx, "rules")
        relations = self.list(ctx, "rule_relations")
        return self._resolve_rules(ctx, projectId, repositoryId, userId, selector, project, repository, rules, relations)

    def _resolve_rules(self, ctx: RuleStoreContext, projectId: str, repositoryId: str, userId: str | None,
                       selector: DocumentData | None, project: DocumentData | None, repository: DocumentData | None,
                       rules: list[DocumentData], relations: list[DocumentData]) -> DocumentData:
        """Resolve a request-scoped, tenant-filtered ruleset without repeating its queries."""
        if (project is None or project.get("ownerWorkspaceId") != ctx.workspaceId or repository is None
                or repository.get("ownerWorkspaceId") != ctx.workspaceId
                or repository.get("projectId") != projectId):
            raise RuleStoreError("NOT_FOUND", 404)
        # A removed repository must not receive rules or a reproducible snapshot.
        if repository.get("status") == "removed":
            return self._save_resolution_snapshot(ctx, projectId, repositoryId, userId, selector, [], [], [])

        active = [rule for rule in rules if rule.get("status") in {"active", "stale"}]
        organization = [rule for rule in active if rule.get("scopeType") == "organization" and rule.get("scopeId") == ctx.workspaceId]
        project_rules = [rule for rule in active if rule.get("scopeType") == "project" and rule.get("projectId") == projectId]
        candidates = [rule for rule in organization + project_rules if _repository_matches(rule, repositoryId) and _selector_matches(rule.get("selector"), selector)]
        candidate_ids = {str(rule["id"]) for rule in candidates}
        candidates_by_id = {str(rule["id"]): rule for rule in candidates}

        # Relations are structural organization -> project edges.  A deny removes
        # its parent here; IMPL-013 separately reads deny relations for _denied.md.
        excluded: set[str] = set()
        resolved_via: dict[str, str] = {}
        for relation in relations:
            parent, child = str(relation.get("parentRuleId")), str(relation.get("childRuleId"))
            if parent not in candidate_ids or child not in candidate_ids:
                continue
            if relation.get("relationType") in {"override", "deny"}:
                uncovered = uncovered_relation_fields(
                    candidates_by_id[parent].get("selector"),
                    candidates_by_id[child].get("selector"), selector,
                )
                if uncovered:
                    # Fail before saving a snapshot or mutating a GitHub branch.
                    # An overlap is not proof that the exception replaces all
                    # contexts where the parent policy applies.
                    raise RuleStoreError("CONDITIONAL_RELATION_UNSUPPORTED", 422, {
                        "parentRuleId": parent, "childRuleId": child,
                        "relationType": relation.get("relationType"), "fields": uncovered,
                    })
                excluded.add(parent)
                resolved_via[child] = str(relation.get("relationType"))
            elif relation.get("relationType") == "extend":
                resolved_via[parent] = resolved_via[child] = "extend"
        resolved_rules = [rule for rule in candidates if str(rule["id"]) not in excluded]
        conflicts = _find_conflicts(resolved_rules, relations)

        version_ids = [str(rule["currentVersionId"]) for rule in resolved_rules if isinstance(rule.get("currentVersionId"), str)]
        versions = {str(version["id"]): version for version in self._get_many(ctx, "rule_versions", version_ids)}
        entries: list[DocumentData] = []
        for rule in resolved_rules:
            version_id = rule.get("currentVersionId")
            if not isinstance(version_id, str):
                continue
            version = versions.get(version_id)
            if version is None or version.get("ruleId") != rule.get("id"):
                continue
            entries.append({"rule": rule, "version": version, "effectiveEnforcement": rule.get("enforcement"), "resolvedVia": resolved_via.get(str(rule["id"]), "inherit")})
        entries.sort(key=lambda entry: (_layer_order(entry["rule"].get("layer")), _enforcement_order(entry["effectiveEnforcement"]), str(entry["rule"].get("key", "")), str(entry["version"].get("id"))))
        if len(entries) > int(LIMITS["limits"]["maxRulesPerResolution"]):
            # Do not truncate and do not create a snapshot (J42).
            raise RuleStoreError("RULE_LIMIT_EXCEEDED", 422, {"maxRulesPerResolution": LIMITS["limits"]["maxRulesPerResolution"]})

        presentation: list[DocumentData] = []
        if userId:
            for rule in active:
                if rule.get("scopeType") != "user" or rule.get("scopeId") != userId or rule.get("enforcement") != "personal":
                    continue
                if _selector_matches(rule.get("selector"), selector):
                    presentation.append({"ruleId": rule.get("id"), "ruleVersionId": rule.get("currentVersionId"), "key": rule.get("key")})
        snapshot = self._save_resolution_snapshot(ctx, projectId, repositoryId, userId, selector, entries, conflicts, presentation)
        # DM 8.1 output metadata is execution-only; the immutable snapshot stores IDs.
        return {**snapshot, "resolvedRules": [{"ruleVersionId": entry["version"]["id"], "effectiveEnforcement": entry["effectiveEnforcement"], "resolvedVia": entry["resolvedVia"]} for entry in entries]}

    def _save_resolution_snapshot(self, ctx: RuleStoreContext, project_id: str, repository_id: str, user_id: str | None, selector: DocumentData | None, entries: list[DocumentData], conflicts: list[DocumentData], presentation: list[DocumentData]) -> DocumentData:
        kept_conflicts, truncation = conflicts[:100], ({"conflicts": {"total": len(conflicts), "kept": 100}} if len(conflicts) > 100 else None)
        id, now = generate_ulid(), datetime.now(UTC).isoformat()
        snapshot: DocumentData = {"id": id, "ownerWorkspaceId": ctx.workspaceId, "projectId": project_id, "repositoryId": repository_id, "userId": user_id, "selector": selector, "ruleVersionIds": [entry["version"]["id"] for entry in entries], "conflicts": kept_conflicts, "truncation": truncation, "presentation": presentation, "resolvedAt": now, "resolverVersion": "impl-010-v1"}
        def save(tx: TransactionLike) -> DocumentData:
            tx.create(self._ref("resolution_snapshots", id), snapshot)
            return snapshot
        return self.runTransaction(save)

    def createAnalysisJob(self, ctx: RuleStoreContext, input: DocumentData) -> DocumentData:
        validateAnalysisJobInput(input); key_hash = sha256HexString(str(input["idempotencyKey"]))
        def create(tx: TransactionLike) -> DocumentData:
            if input["type"] != "purge":
                project_snapshot = tx.get(self._ref("projects", str(input.get("projectId")))); project = project_snapshot.to_dict()
                if not project_snapshot.exists or not project or project.get("ownerWorkspaceId") != ctx.workspaceId or project.get("deletedAt") or project.get("status") != "active":
                    raise RuleStoreError("PROJECT_DELETED", 409, {"projectId": input.get("projectId")})
            key_ref = self._ref("unique_keys", uniqueKeyId("job_idempotency", {"idempotencyKeyHash": key_hash}))
            existing = tx.get(key_ref)
            if existing.exists:
                key = existing.to_dict() or {}
                # The persisted key ID is hash-only for contract compatibility.
                # Never follow a colliding key across a Workspace boundary.
                if key.get("ownerWorkspaceId") != ctx.workspaceId:
                    raise RuleStoreError("UNIQUE_VIOLATION", 409, {"kind": "job_idempotency"})
                target = key["targetId"]; job_snapshot = tx.get(self._ref("analysis_jobs", target)); job = job_snapshot.to_dict()
                if job_snapshot.exists and job and job.get("ownerWorkspaceId") == ctx.workspaceId:
                    return {"job": job, "created": False}
                raise RuleStoreError("IDEMPOTENCY_TARGET_MISSING", 409)
            id, now = generate_ulid(), datetime.now(UTC).isoformat()
            job: DocumentData = {"id": id, "ownerWorkspaceId": ctx.workspaceId, "projectId": input.get("projectId"), "type": input["type"], "payload": input["payload"], "status": "queued", "attempts": 0, "idempotencyKey": input["idempotencyKey"], "error": None, "warnings": [], "warningsOverflow": 0, "createdAt": now, "startedAt": None, "finishedAt": None}
            if input["type"] != "purge": tx.update(self._ref("projects", str(input.get("projectId"))), {"mutationFenceAt": now})
            self._reserve_unique_key(tx, "job_idempotency", {"idempotencyKeyHash": key_hash, "ownerWorkspaceId": ctx.workspaceId}, {"targetTable": "analysis_jobs", "targetId": id}, existing); tx.create(self._ref("analysis_jobs", id), job)
            self.appendAuditLog(ctx, {"actor": {"kind": ctx.actorKind or "user", "id": ctx.actorUserId or "system"}, "action": "job.create", "targetType": "analysis_jobs", "targetId": id, "requestId": input.get("requestId", f"job:{id}"), "after": {"type": input["type"], "idempotencyKey": input["idempotencyKey"]}}, tx)
            return {"job": job, "created": True}
        try: return self.runTransaction(create)
        except RuleStoreError as error:
            if error.code != "UNIQUE_VIOLATION": raise
            key = self.get(ctx, "unique_keys", uniqueKeyId("job_idempotency", {"idempotencyKeyHash": key_hash}))
            job = self.get(ctx, "analysis_jobs", str(key["targetId"])) if key else None
            if job is None: raise
            return {"job": job, "created": False}

    def updateAnalysisJobStatus(self, ctx: RuleStoreContext, jobId: str, status: str, opts: DocumentData | None = None) -> DocumentData:
        options = opts or {}
        def update(tx: TransactionLike) -> DocumentData:
            ref = self._ref("analysis_jobs", jobId); snapshot = tx.get(ref); job = snapshot.to_dict()
            if not snapshot.exists or job is None or job.get("ownerWorkspaceId") != ctx.workspaceId: raise RuleStoreError("NOT_FOUND", 404)
            if ("expectedExecutionOwner" in options and job.get("executionOwner") != options["expectedExecutionOwner"]
                    or "expectedStartedAt" in options and job.get("startedAt") != options["expectedStartedAt"]):
                raise RuleStoreError("EXECUTION_CHANGED", 409)
            if not _valid_transition(str(job["status"]), status): raise RuleStoreError("INVALID_STATUS_TRANSITION", 422, {"from": job["status"], "to": status})
            if status == "running" and job.get("type") != "purge":
                project_snapshot = tx.get(self._ref("projects", str(job.get("projectId")))); project = project_snapshot.to_dict()
                if not project_snapshot.exists or not project or project.get("ownerWorkspaceId") != ctx.workspaceId or project.get("deletedAt") or project.get("status") != "active":
                    raise RuleStoreError("PROJECT_DELETED", 409, {"projectId": job.get("projectId")})
            now = datetime.now(UTC).isoformat(); supplied = options.get("warnings")
            warnings = list(supplied[:int(LIMITS["analysisJobs"]["maxWarnings"])]) if supplied is not None else job.get("warnings", [])
            overflow = max(0, len(supplied) - int(LIMITS["analysisJobs"]["maxWarnings"])) if supplied is not None else job.get("warningsOverflow", 0)
            consume_attempt = options.get("consumeAttempt", True) is not False
            attempts = int(job["attempts"]) + (1 if status == "failed" and consume_attempt else 0); final = "dead" if status == "failed" and attempts >= int(options.get("maxAttempts", LIMITS["analysisJobs"]["defaultMaxAttempts"])) else status
            patch: DocumentData = {"status": final, "attempts": attempts, "warnings": warnings, "warningsOverflow": overflow, "error": options.get("error", None if final == "done" else job.get("error"))}
            if status == "running":
                patch.update({"startedAt": now, "executionOwner": options.get("executionOwner"),
                              "executionDeadline": options.get("executionDeadline")})
            if final in {"done", "dead"}: patch["finishedAt"] = now
            key_ref = self._ref("unique_keys", uniqueKeyId("job_idempotency", {"idempotencyKeyHash": sha256HexString(str(job["idempotencyKey"]))}))
            key_snapshot = tx.get(key_ref) if final == "dead" else None
            tx.update(ref, patch)
            if status == "running" and job.get("type") != "purge": tx.update(self._ref("projects", str(job.get("projectId"))), {"mutationFenceAt": now})
            if key_snapshot is not None and key_snapshot.exists: tx.delete(key_ref)
            for warning in supplied or []: self.appendAuditLog(ctx, {"actor": {"kind": "ai", "id": "worker"}, "action": "ai.warning", "targetType": "analysis_jobs", "targetId": jobId, "requestId": options.get("requestId", f"job:{jobId}"), "after": warning}, tx)
            return {**job, **patch}
        return self.runTransaction(update)

    def createBootstrapBatch(self, ctx: RuleStoreContext, projectId: str, candidates: list[DocumentData]) -> list[DocumentData]:
        """Persist fully verified bootstrap proposals atomically (DM 7.2/J54)."""
        maximum = int(LIMITS["limits"]["maxBootstrapRules"])
        evidence_maximum = int(LIMITS["limits"]["maxEvidencePerBootstrapRule"])
        if len(candidates) > maximum:
            raise ValueError("bootstrap candidate limit exceeded")
        if any(len(candidate.get("evidence", [])) > evidence_maximum for candidate in candidates):
            raise ValueError("bootstrap evidence limit exceeded")
        keys = [candidate.get("key") for candidate in candidates]
        if any(not isinstance(key, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", key) for key in keys):
            raise RuleStoreError("INVALID_RULE", 422)
        if len(set(keys)) != len(keys):
            raise RuleStoreError("UNIQUE_VIOLATION", 409, {"kind": "rule_key"})

        def create(tx: TransactionLike) -> list[DocumentData]:
            project_snapshot = tx.get(self._ref("projects", projectId))
            if not project_snapshot.exists or (project_snapshot.to_dict() or {}).get("ownerWorkspaceId") != ctx.workspaceId:
                raise RuleStoreError("NOT_FOUND", 404)
            created: list[DocumentData] = []
            now = datetime.now(UTC).isoformat()
            actor = {"kind": "ai", "id": "worker"}
            prepared: list[tuple[DocumentData, list[DocumentData], str, str, DocumentSnapshotLike]] = []
            for candidate in candidates:
                key = candidate.get("key")
                if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", key):
                    raise RuleStoreError("INVALID_RULE", 422)
                if candidate.get("enforcement") not in {"default", "advisory"}:
                    raise RuleStoreError("INVALID_ENFORCEMENT", 422)
                evidence = candidate.get("evidence")
                if not isinstance(evidence, list) or not evidence:
                    raise RuleStoreError("EVIDENCE_REQUIRED", 422)
                rule_id, version_id = generate_ulid(), generate_ulid()
                key_ref = self._ref("unique_keys", uniqueKeyId("rule_key", {"ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": projectId, "key": key}))
                prepared.append((candidate, evidence, rule_id, version_id, tx.get(key_ref)))
            for candidate, evidence, rule_id, version_id, key_snapshot in prepared:
                key = str(candidate["key"])
                self._reserve_unique_key(tx, "rule_key", {"ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": projectId, "key": key}, {"targetTable": "rules", "targetId": rule_id}, key_snapshot)
                provenance = dict(candidate.get("provenance") or {})
                provenance.update({"sourceType": "ai", "derivedFromCustomerCode": True})
                selector = candidate.get("selector") if isinstance(candidate.get("selector"), dict) else {}
                selector = {field: list(selector.get(field, [])) if isinstance(selector.get(field, []), list) else [] for field in ("languages", "frameworks", "directoryGlobs", "dependencies", "repositoryIds")}
                rule: DocumentData = {"id": rule_id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": projectId, "visibility": "private", "enforcement": candidate["enforcement"], "transferPolicy": "project-only", "licenseType": "proprietary-customer", "provenance": provenance, "containsPersonalData": False, "containsConfidentialData": True, "retentionClass": "standard", "createdBy": actor, "createdAt": now, "updatedAt": now, "deletedAt": None, "projectId": projectId, "currentVersionId": None, "nextVersion": 2, "key": key, "title": candidate.get("title", key), "layer": candidate.get("layer"), "type": candidate.get("type"), "evaluationMode": candidate.get("evaluationMode"), "status": "draft", "selector": selector, "ownerUserId": None, "maintenance": {"reviewIntervalDays": None, "watchDependencies": [], "expiresAt": None}, "supersededByRuleId": None, "staleSince": None, "tags": []}
                tx.create(self._ref("rules", rule_id), rule)
                evidence_ids: list[str] = []
                for item in evidence:
                    value = dict(item); evidence_id = str(value["id"]); evidence_ids.append(evidence_id)
                    value.update({"ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": projectId, "visibility": "private", "enforcement": None, "transferPolicy": "prohibited", "licenseType": "proprietary-customer", "provenance": provenance, "containsPersonalData": False, "containsConfidentialData": True, "retentionClass": "evidence", "createdBy": actor, "createdAt": now, "updatedAt": now, "deletedAt": None, "capturedAt": now, "excerptPurgedAt": None})
                    tx.create(self._ref("evidence", evidence_id), value)
                version: DocumentData = {"id": version_id, "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": projectId, "visibility": "private", "enforcement": candidate["enforcement"], "transferPolicy": "project-only", "licenseType": "proprietary-customer", "provenance": provenance, "containsPersonalData": False, "containsConfidentialData": True, "retentionClass": "standard", "createdBy": actor, "createdAt": now, "updatedAt": now, "deletedAt": None, "ruleId": rule_id, "version": 1, "content": candidate.get("content", ""), "rationale": candidate.get("rationale", ""), "evidenceIds": evidence_ids, "compatibility": candidate.get("compatibility", {"frameworks": {}, "languages": {}, "tools": {}}), "changeType": "initial", "triggerId": None, "driftFindingIds": [], "supersedes": None, "status": "proposed", "approvedBy": None, "approvedAt": None, "rejectionReason": None, "effectiveFrom": None, "effectiveTo": None, "aiSummary": None, "truncation": None}
                tx.create(self._ref("rule_versions", version_id), version)
                self.appendAuditLog(ctx, {"actor": actor, "action": "rule.bootstrap_create", "targetType": "rules", "targetId": rule_id, "requestId": f"bootstrap:{projectId}", "after": {"key": key, "ruleVersionId": version_id}}, tx)
                created.append({"rule": rule, "ruleVersion": version})
            return created
        return self.runTransaction(create)

    def createDriftScanBatch(self, ctx: RuleStoreContext, triggerId: str, findings: list[DocumentData]) -> list[DocumentData]:
        """Materialize validated AI drift output atomically; capped at 50 findings (<=401 writes)."""
        maximum = int(LIMITS["limits"]["maxFindingsPerDriftScan"])
        selected, truncated = findings[:maximum], len(findings) > maximum
        def create(tx: TransactionLike) -> list[DocumentData]:
            trigger_ref = self._ref("change_triggers", triggerId); trigger_snap = tx.get(trigger_ref); trigger = trigger_snap.to_dict()
            if not trigger_snap.exists or not trigger or trigger.get("ownerWorkspaceId") != ctx.workspaceId: raise RuleStoreError("NOT_FOUND", 404)
            # Guard the transaction itself as well as the handler. This closes the
            # concurrent-attempt race where both attempts read processedAt=null
            # before one commits the atomic batch.
            if trigger.get("processedAt") is not None: return []
            now, ids, output = datetime.now(UTC).isoformat(), [], []
            threshold = LIMITS["drift"]["staleThreshold"]; ranks = ["info", "low", "medium", "high"]
            prepared: list[tuple[DocumentData, list[DocumentData], DocumentData]] = []
            for raw in selected:
                if raw.get("driftType") not in {"dependency_drift", "compatibility_drift"} or raw.get("severity") not in ranks or not isinstance(raw.get("confidence"), (int, float)): raise RuleStoreError("INVALID_DRIFT_FINDING", 422)
                evidence = raw.get("evidence", []); 
                if not isinstance(evidence, list) or not evidence: raise RuleStoreError("EVIDENCE_REQUIRED", 422)
                rule_id = str(raw["ruleId"])
                rule_snap = tx.get(self._ref("rules", rule_id)); rule = rule_snap.to_dict()
                if not rule_snap.exists or not rule or rule.get("ownerWorkspaceId") != ctx.workspaceId: continue
                if raw.get("ruleVersionId") is not None and raw["ruleVersionId"] != rule.get("currentVersionId"):
                    continue
                prepared.append((raw, evidence, rule))
            for raw, evidence, rule in prepared:
                rule_id, finding_id, evidence_ids = str(raw["ruleId"]), generate_ulid(), []
                provenance = {**raw.get("provenance", {}), "sourceType": "ai", "sourceRef": triggerId, "model": raw.get("provenance", {}).get("model", raw.get("model", "ai.model.fast")), "promptVersion": raw.get("provenance", {}).get("promptVersion", "drift-detector-v1"), "derivedFromCustomerCode": True}
                for item in evidence:
                    eid = str(item.get("id", generate_ulid())); evidence_ids.append(eid); value = {**item, "id": eid, "ownerWorkspaceId": ctx.workspaceId, "scopeType": "project", "scopeId": trigger.get("projectId"), "provenance": provenance, "createdBy": {"kind":"ai","id":"worker"}, "createdAt":now, "updatedAt":now, "deletedAt":None, "retentionClass":"evidence"}; tx.create(self._ref("evidence", eid), value)
                finding = {"id":finding_id,"ownerWorkspaceId":ctx.workspaceId,"scopeType":"project","scopeId":trigger.get("projectId"),"projectId":trigger.get("projectId"),"repositoryId":(trigger.get("source") or {}).get("repositoryId"),"visibility":"private","enforcement":None,"transferPolicy":"project-only","licenseType":"proprietary-customer","provenance":provenance,"containsPersonalData":False,"containsConfidentialData":True,"retentionClass":"standard","createdBy":{"kind":"ai","id":"worker"},"createdAt":now,"updatedAt":now,"deletedAt":None,"ruleId":rule_id,"ruleVersionId":rule.get("currentVersionId"),"triggerId":triggerId,"driftType":raw["driftType"],"severity":raw["severity"],"confidence":raw["confidence"],"summary":raw.get("summary", ""),"detail":raw.get("detail", ""),"evidenceIds":evidence_ids,"provenanceIds":[],"status":"open","triagedBy":None,"triagedAt":None,"dismissReason":None,"resolvedByRuleVersionId":None,"resolvedAt":None,"reopenCount":0,"proposalVersionId":None,"truncation":None}
                tx.create(self._ref("drift_findings", finding_id), finding); ids.append(finding_id); output.append(finding)
                if ranks.index(str(raw["severity"])) >= ranks.index(str(threshold["minimumSeverity"])) and float(raw["confidence"]) >= float(threshold["minimumConfidence"]) and rule.get("status") in {"active", "stale"}: tx.update(self._ref("rules", rule_id), {"status":"stale", "staleSince":rule.get("staleSince") or now, "updatedAt":now})
                self.appendAuditLog(ctx, {"actor":{"kind":"ai","id":"worker"},"action":"drift.detect","targetType":"drift_findings","targetId":finding_id,"requestId":f"drift_scan:{triggerId}","after":{"ruleId":rule_id}}, tx)
            tx.update(trigger_ref, {"resultingFindingIds":ids,"processedAt":now,"truncation": {"reason":"maxFindingsPerDriftScan","originalCount":len(findings),"kept":maximum} if truncated else None,"updatedAt":now})
            return output
        return self.runTransaction(create)

    def writeCompiledArtifacts(self, ctx: RuleStoreContext, artifacts: list[DocumentData]) -> None:
        """Persist generated files before the revision PR transaction commit point."""
        # Firestore enforces both a write-count and a 10 MiB request ceiling.
        # The content field alone can be 200 KiB, so count-only batching can
        # exceed the byte limit long before it reaches 450 writes.
        for batch in _compiled_artifact_batches(artifacts):
            # A small transaction per batch keeps the injected in-memory store useful
            # while production adapters retain both service boundaries.
            def write(tx: TransactionLike, values: list[DocumentData] = batch) -> None:
                for value in values:
                    if value.get("ownerWorkspaceId") != ctx.workspaceId:
                        raise RuleStoreError("FORBIDDEN", 403)
                    tx.create(self._ref("compiled_artifacts", str(value["id"])), value)
            self.runTransaction(write)

    def pruneCompiledArtifacts(self, ctx: RuleStoreContext, revisionPrId: str, keepIds: set[str]) -> int:
        """Remove superseded generations after the revision PR commit point.

        A draft PR has one authoritative resolution snapshot.  Keeping every
        recompile for that same draft makes reads and storage grow without
        bound.  The caller supplies the just-written IDs so retries also remove
        duplicate documents for the current snapshot.
        """
        stale = [
            artifact for artifact in self.list(ctx, "compiled_artifacts", {"revisionPrId": revisionPrId})
            if str(artifact["id"]) not in keepIds
        ]
        removed = 0
        maximum_writes = int(LIMITS["limits"]["maxTransactionWrites"])
        for start in range(0, len(stale), maximum_writes):
            values = stale[start:start + maximum_writes]
            def delete(tx: TransactionLike, batch: list[DocumentData] = values) -> None:
                for artifact in batch:
                    tx.delete(self._ref("compiled_artifacts", str(artifact["id"])))
            self.runTransaction(delete)
            removed += len(values)
        return removed

    def openRevisionPr(self, ctx: RuleStoreContext, input: DocumentData) -> DocumentData:
        """Create the sole open draft record, or atomically advance its snapshot."""
        repository_id = str(input["repositoryId"])
        def open_pr(tx: TransactionLike) -> DocumentData:
            key_ref = self._ref("unique_keys", uniqueKeyId("revision_pr_open", {"repositoryId": repository_id}))
            key = tx.get(key_ref)
            if key.exists:
                target_id = str((key.to_dict() or {})["targetId"])
                existing_ref = self._ref("revision_prs", target_id); existing = tx.get(existing_ref)
                if existing.exists and (existing.to_dict() or {}).get("status") == "draft_open":
                    patch = {"resolutionSnapshotId": input["resolutionSnapshotId"],
                             "ruleVersionIds": input.get("ruleVersionIds", []),
                             "expectedDeletedPaths": input.get("expectedDeletedPaths", (existing.to_dict() or {}).get("expectedDeletedPaths", [])),
                             "updatedAt": datetime.now(UTC).isoformat()}
                    tx.update(existing_ref, patch)
                    return {**(existing.to_dict() or {}), **patch}
                raise RuleStoreError("UNIQUE_VIOLATION", 409, {"kind": "revision_pr_open", "value": repository_id})
            value = dict(input)
            if value.get("isDraft") is not True: raise RuleStoreError("DRAFT_REQUIRED", 422)
            value.setdefault("id", generate_ulid()); value.setdefault("ownerWorkspaceId", ctx.workspaceId)
            value.setdefault("status", "draft_open"); value.setdefault("openedAt", datetime.now(UTC).isoformat())
            value.setdefault("mergedAt", None); value.setdefault("closedAt", None); value.setdefault("mergeCommitSha", None); value.setdefault("verification", None)
            self._reserve_unique_key(tx, "revision_pr_open", {"repositoryId": repository_id, "ownerWorkspaceId": ctx.workspaceId}, {"targetTable": "revision_prs", "targetId": str(value["id"])}, key)
            tx.create(self._ref("revision_prs", str(value["id"])), value)
            self.appendAuditLog(ctx, {"actor": {"kind": "ai", "id": "worker"}, "action": "pr.draft_open", "targetType": "revision_prs", "targetId": str(value["id"]), "requestId": input.get("requestId", f"compile:{value['id']}"), "after": {"repositoryId": repository_id, "isDraft": True}}, tx)
            return value
        return self.runTransaction(open_pr)

    def recordPublishVerification(self, ctx: RuleStoreContext, revisionPrId: str, result: DocumentData) -> None:
        """Atomically retain only the latest verification result for a merged PR."""
        def record(tx: TransactionLike) -> None:
            ref = self._ref("revision_prs", revisionPrId); snap = tx.get(ref); value = snap.to_dict()
            if not snap.exists or not value or value.get("ownerWorkspaceId") != ctx.workspaceId or value.get("status") != "merged": raise RuleStoreError("NOT_FOUND", 404)
            tx.update(ref, {"verification": result})
        self.runTransaction(record)


def validateAnalysisJobInput(input: DocumentData) -> None:
    type, key = input.get("type"), input.get("idempotencyKey")
    if type not in ANALYSIS_JOB_TYPES: raise RuleStoreError("INVALID_JOB_TYPE", 422)
    if not isinstance(key, str) or len(key) > int(LIMITS["analysisJobs"]["maxIdempotencyKeyLength"]) or not re.fullmatch(r"[a-z_]+(:[A-Za-z0-9._-]+)+", key): raise RuleStoreError("INVALID_IDEMPOTENCY_KEY", 422)
    parts = key.split(":")
    if parts[0] != type or len(parts) not in _KEY_PARTS[type] or (type == "purge" and len(parts) == 4 and parts[1] != "subject"): raise RuleStoreError("INVALID_IDEMPOTENCY_KEY", 422)
    if not isinstance(input.get("payload"), dict) or len(canonicalJson(input.get("payload")).encode()) > int(LIMITS["analysisJobs"]["maxPayloadBytes"]): raise RuleStoreError("PAYLOAD_TOO_LARGE", 422)
    if (type == "purge") != (input.get("projectId") is None): raise RuleStoreError("INVALID_PROJECT_ID", 422)


def _validate_rule_version_input(input: DocumentData) -> None:
    if not isinstance(input.get("content"), str) or len(input["content"].encode()) > int(LIMITS["ruleVersions"]["maxContentBytes"]): raise RuleStoreError("INVALID_CONTENT", 422)
    if not isinstance(input.get("rationale"), str) or len(input["rationale"].encode()) > int(LIMITS["ruleVersions"]["maxRationaleBytes"]): raise RuleStoreError("INVALID_RATIONALE", 422)
    evidence = input.get("evidenceIds", [])
    if not isinstance(evidence, list) or len(evidence) > int(LIMITS["limits"]["maxEvidencePerVersion"]) or any(not isinstance(item, str) for item in evidence): raise RuleStoreError("INVALID_EVIDENCE_IDS", 422)
    if not isinstance(input.get("driftFindingIds", []), list) or len(input.get("driftFindingIds", [])) > int(LIMITS["ruleVersions"]["maxDriftFindingIds"]) or not isinstance(input.get("changeType"), str): raise RuleStoreError("INVALID_RULE_VERSION", 422)
    if input.get("aiSummary") is not None and (not isinstance(input["aiSummary"], str) or len(input["aiSummary"].encode()) > int(LIMITS["ruleVersions"]["maxAiSummaryBytes"])): raise RuleStoreError("INVALID_AI_SUMMARY", 422)
    provenance = input.get("provenance")
    if isinstance(provenance, dict) and provenance.get("sourceType") == "ai" and not evidence: raise RuleStoreError("EVIDENCE_REQUIRED", 422)


def _values(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _repository_matches(rule: DocumentData, repository_id: str) -> bool:
    repository_ids = _values((rule.get("selector") or {}).get("repositoryIds")) if isinstance(rule.get("selector"), dict) else []
    return not repository_ids or repository_id in repository_ids


def _selector_matches(rule_selector: Any, requested: DocumentData | None) -> bool:
    """Rule selectors are unconstrained when absent; repositoryIds are evaluated separately."""
    if not isinstance(requested, dict) or not isinstance(rule_selector, dict):
        return True
    for name in ("languages", "frameworks", "dependencies"):
        rule_values, request_values = _values(rule_selector.get(name)), _values(requested.get(name))
        if rule_values and request_values:
            if name in {"languages", "frameworks"}:
                if not {value.casefold() for value in rule_values} & {value.casefold() for value in request_values}: return False
            elif not set(rule_values) & set(request_values): return False
    patterns, requested_patterns = _values(rule_selector.get("directoryGlobs")), _values(requested.get("directoryGlobs"))
    if patterns and requested_patterns and not any(fnmatchcase(value, pattern) or fnmatchcase(pattern, value) for pattern in patterns for value in requested_patterns): return False
    return True


def _selector_identity(rule: DocumentData) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    selector = rule.get("selector") if isinstance(rule.get("selector"), dict) else {}
    return (
        tuple(sorted(value.casefold() for value in _values(selector.get("languages")))),
        tuple(sorted(value.casefold() for value in _values(selector.get("frameworks")))),
        tuple(sorted(_values(selector.get("directoryGlobs")))),
        tuple(sorted(_values(selector.get("dependencies")))),
    )


def _find_conflicts(rules: list[DocumentData], relations: list[DocumentData]) -> list[DocumentData]:
    related = {frozenset((str(relation.get("parentRuleId")), str(relation.get("childRuleId")))) for relation in relations}
    conflicts: list[DocumentData] = []
    for index, rule in enumerate(rules):
        for other in rules[index + 1:]:
            if rule.get("key") == other.get("key") and _selector_identity(rule) == _selector_identity(other) and frozenset((str(rule["id"]), str(other["id"]))) not in related:
                conflicts.append({"ruleId": rule["id"], "conflictingRuleId": other["id"], "reason": "same_key_and_selector"})
    return conflicts


def _layer_order(value: Any) -> int:
    return {"L1": 1, "L2": 2, "L3": 3}.get(str(value), 99)


def _enforcement_order(value: Any) -> int:
    return {"locked": 1, "default": 2, "advisory": 3}.get(str(value), 99)


def _valid_transition(from_status: str, to_status: str) -> bool:
    return to_status in LIMITS["analysisJobs"]["validStatusTransitions"].get(from_status, [])

