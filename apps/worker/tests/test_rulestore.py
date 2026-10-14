from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_firestore import InMemoryFirestore
from rulebranch.rulestore import (
    MAX_COMPILED_ARTIFACT_BATCH_BYTES, FirestoreRuleStore, RULE_STORE_METHOD_SIGNATURES,
    RuleStoreError, RuleStoreContext, _CountingTransaction, _compiled_artifact_batches,
    _compiled_artifact_write_size, canonicalJson, requireHumanActor, sha256, uniqueKeyId,
    withHumanActorGuard,
)

CTX = RuleStoreContext("workspace-a", "user-a")
ENTRY = {"actor": {"kind": "user", "id": "user-a"}, "action": "rule.create", "targetType": "rules", "targetId": "rule-a", "requestId": "request-a"}

class RuleStoreFoundationTests(unittest.TestCase):
    def store(self) -> tuple[InMemoryFirestore, FirestoreRuleStore]:
        db = InMemoryFirestore(); return db, FirestoreRuleStore(db)

    def test_tenant_read_and_list_hide_other_workspace(self) -> None:
        db, store = self.store(); db.put("rules", "other", {"ownerWorkspaceId": "workspace-b"})
        self.assertIsNone(store.get(CTX, "rules", "other")); self.assertEqual(store.list(CTX, "rules"), [])

    def test_bulk_get_uses_one_rpc_and_preserves_order_and_duplicates(self) -> None:
        db, store = self.store()
        db.put("evidence", "one", {"id": "one", "ownerWorkspaceId": "workspace-a"})
        db.put("evidence", "two", {"id": "two", "ownerWorkspaceId": "workspace-a"})
        db.put("evidence", "hidden", {"id": "hidden", "ownerWorkspaceId": "workspace-b"})
        values = store._get_many(CTX, "evidence", ["two", "one", "two", "missing", "hidden"])
        self.assertEqual([value["id"] for value in values], ["two", "one", "two"])
        self.assertEqual(db.get_all_calls, 1)

    def test_unique_key_conflict_is_409_with_kind_and_value(self) -> None:
        db, store = self.store()
        # Both transactions read an absent reservation.  Only the first commit can
        # create it; the loser retries and receives the documented 409 response.
        first, second = db.transaction(), db.transaction()
        store.reserveUniqueKey(first, "project_slug", {"ownerWorkspaceId": "workspace-a", "slug": "alpha"}, {"targetTable": "projects", "targetId": "p1"})
        store.reserveUniqueKey(second, "project_slug", {"ownerWorkspaceId": "workspace-a", "slug": "alpha"}, {"targetTable": "projects", "targetId": "p2"})
        self.assertTrue(first.commit()); self.assertFalse(second.commit())
        with self.assertRaises(RuleStoreError) as caught:
            store.runTransaction(lambda tx: store.reserveUniqueKey(tx, "project_slug", {"ownerWorkspaceId": "workspace-a", "slug": "alpha"}, {"targetTable": "projects", "targetId": "p2"}))
        self.assertEqual(caught.exception.status, 409); self.assertEqual(caught.exception.code, "UNIQUE_VIOLATION")
        self.assertEqual(caught.exception.details, {"kind": "project_slug", "value": "workspace-a:alpha"})
        self.assertEqual(len(store.list(CTX, "unique_keys")), 1)

    def test_all_twelve_unique_key_ids_match_dm_527(self) -> None:
        cases = [
            ("github_user", {"githubUserId": "1"}, "github_user:1"), ("user_preference", {"userId": "u"}, "user_preference:u"), ("github_org", {"githubOrgId": "2"}, "github_org:2"), ("github_installation", {"githubInstallationId": "3"}, "github_installation:3"), ("github_repo", {"githubRepoId": "4"}, "github_repo:4"), ("workspace_member", {"workspaceId": "w", "userId": "u"}, "workspace_member:w:u"), ("workspace_invitation_pending", {"workspaceId": "w", "invitedGithubUserId": "5"}, "workspace_invitation_pending:w:5"), ("project_slug", {"ownerWorkspaceId": "w", "slug": "p"}, "project_slug:w:p"), ("rule_key", {"ownerWorkspaceId": "w", "scopeType": "project", "scopeId": "p", "key": "r"}, "rule_key:w:project:p:r"), ("rule_relation_child", {"childRuleId": "r"}, "rule_relation_child:r"), ("revision_pr_open", {"repositoryId": "r"}, "revision_pr_open:r"), ("job_idempotency", {"idempotencyKeyHash": "a" * 64}, "job_idempotency:" + "a" * 64),
        ]
        for kind, components, expected in cases: self.assertEqual(uniqueKeyId(kind, components), expected)

    def test_451st_write_fails_before_commit(self) -> None:
        db, store = self.store()
        def write_many(tx: object) -> None:
            for number in range(451): tx.create(db.collection("rules").document(str(number)), {"ownerWorkspaceId": "workspace-a"})
        with self.assertRaises(RuleStoreError) as caught: store.runTransaction(write_many)
        self.assertEqual(caught.exception.details["maxTransactionWrites"], 450); self.assertEqual(store.list(CTX, "rules"), [])

    def test_transaction_adapter_unwraps_production_generator_and_guards_read_order(self) -> None:
        db = InMemoryFirestore(); db.put("rules", "rule", {"id": "rule", "ownerWorkspaceId": "workspace-a"})
        native = db.transaction()

        class GeneratorGetTransaction:
            def get(self, ref: object) -> object:
                yield native.get(ref)  # production Transaction.get is iterator-shaped
            def create(self, ref: object, data: dict[str, object]) -> None: native.create(ref, data)
            def update(self, ref: object, data: dict[str, object]) -> None: native.update(ref, data)
            def delete(self, ref: object) -> None: native.delete(ref)

        tx = _CountingTransaction(GeneratorGetTransaction())
        ref = db.collection("rules").document("rule")
        self.assertEqual(tx.get(ref).to_dict()["id"], "rule")
        tx.update(ref, {"status": "active"})
        with self.assertRaisesRegex(RuntimeError, "all reads before writes"):
            tx.get(ref)

    def test_transaction_adapter_reads_a_limited_query(self) -> None:
        db = InMemoryFirestore()
        db.put("drift_findings", "open", {"id": "open", "ownerWorkspaceId": "workspace-a", "ruleId": "rule", "status": "open"})
        db.put("drift_findings", "closed", {"id": "closed", "ownerWorkspaceId": "workspace-a", "ruleId": "rule", "status": "resolved"})
        tx = _CountingTransaction(db.transaction(), db)
        values = tx.query("drift_findings", {"ownerWorkspaceId": "workspace-a", "ruleId": "rule", "status": "open"}, limit=1)
        self.assertEqual([value.id for value in values], ["open"])

    def test_compiled_artifacts_are_batched_by_wire_size_and_write_count(self) -> None:
        artifacts = [
            {"id": f"artifact-{index}", "ownerWorkspaceId": CTX.workspaceId, "content": "x" * (200 * 1024)}
            for index in range(60)
        ]
        batches = _compiled_artifact_batches(artifacts)
        self.assertGreater(len(batches), 1)
        self.assertEqual(sum(len(batch) for batch in batches), len(artifacts))
        self.assertTrue(all(len(batch) <= 450 for batch in batches))
        self.assertTrue(all(sum(_compiled_artifact_write_size(item) for item in batch) <= MAX_COMPILED_ARTIFACT_BATCH_BYTES for batch in batches))

        _, store = self.store()
        store.writeCompiledArtifacts(CTX, artifacts)
        self.assertEqual(len(store.list(CTX, "compiled_artifacts")), len(artifacts))

    def test_audit_hash_and_32kib_truncation(self) -> None:
        _, store = self.store(); before, after = {"z": 1, "a": "x" * (33 * 1024)}, {"b": 2}
        store.appendAuditLog(CTX, {**ENTRY, "before": before, "after": after}); audit = store.list(CTX, "audit_logs")[0]
        self.assertEqual(audit["before"], {"_truncated": True, "sha256": sha256(before)})
        self.assertEqual(audit["payloadHash"], sha256({"before": before, "after": after})); self.assertEqual(audit["retentionClass"], "audit")
        self.assertEqual(canonicalJson({"z": 1, "a": 2}), '{"a":2,"z":1}')
        with self.assertRaises(ValueError): store.appendAuditLog(CTX, {**ENTRY, "requestId": ""})

    def test_audit_is_append_only_and_redaction_is_guarded(self) -> None:
        _, store = self.store(); self.assertFalse(hasattr(store, "updateAuditLog")); self.assertFalse(hasattr(store, "deleteAuditLog"))
        with self.assertRaises(RuleStoreError): store.redactAuditLogPayloads(CTX, {"workspaceId": "workspace-a"})
        self.assertEqual(store.redactAuditLogPayloads(RuleStoreContext("workspace-a", None, "system"), {"workspaceId": "workspace-a"}), {"count": 0})

    def test_ai_context_is_rejected_from_protected_operations(self) -> None:
        ai = RuleStoreContext("workspace-a", None)
        for operation in ("approveRuleVersion", "addMember", "updateMemberRole", "removeMember", "createInvitation", "listInvitations", "updateInvitationStatus", "listMembers"):
            with self.assertRaises(RuleStoreError): requireHumanActor(ai, operation)
        for status in ("deprecated", "superseded", "archived"):
            with self.assertRaises(RuleStoreError): requireHumanActor(ai, "updateRuleStatus", status)
        guarded = withHumanActorGuard("approveRuleVersion", lambda _ctx: "ok")
        with self.assertRaises(RuleStoreError): guarded(ai)

    def test_ts_python_signature_manifest_matches(self) -> None:
        source = (Path(__file__).resolve().parents[2] / "web" / "src" / "shared" / "rulestore.ts").read_text()
        import re
        match = re.search(r"RULE_STORE_METHOD_SIGNATURES = Object\.freeze\(\[([\s\S]*?)\] as const\)", source)
        self.assertIsNotNone(match)
        pairs = [(name, arguments) for name, arguments in re.findall(r'\["([^"]+)", "([^"]+)"\]', match.group(1))]
        self.assertEqual(tuple(pairs), RULE_STORE_METHOD_SIGNATURES)

if __name__ == "__main__": unittest.main()
