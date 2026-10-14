from __future__ import annotations
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from rulebranch import compiler
from rulebranch.contracts import ENUMS, LIMITS
from rulebranch.purge import GOV_AND_CONTENT, PurgeJobHandler
from rulebranch.rulestore import (
    ANALYSIS_JOB_TYPES, UNIQUE_KEY_KINDS, FirestoreRuleStore, RuleStoreContext, RuleStoreError,
    canonicalJson, validateAnalysisJobInput, _validate_rule_version_input,
)

def build_key(type_: str, segments: int) -> str:
    rest = ["subject" if type_ == "purge" and segments == 4 and i == 0 else f"s{i}" for i in range(segments - 1)]
    return ":".join([type_, *rest])

class ContractsConsolidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = InMemoryFirestore(); self.store = FirestoreRuleStore(self.db)
        self.db.put("projects", "p", {"id": "p", "ownerWorkspaceId": "w", "status": "active", "deletedAt": None})
    def put(self, table: str, id: str, **data: object) -> None: self.db.put(table, id, {"id": id, **data})

    def test_analysis_job_types_and_unique_key_kinds_do_not_drift_from_the_enum_contract(self) -> None:
        self.assertEqual(ANALYSIS_JOB_TYPES, frozenset(ENUMS["analysis_jobs.type"]))
        self.assertEqual(UNIQUE_KEY_KINDS, tuple(ENUMS["unique_keys.kind"]))

    def test_compiler_artifact_size_cap_matches_the_shared_contract(self) -> None:
        self.assertEqual(compiler.MAX_ARTIFACT_CONTENT_BYTES, LIMITS["limits"]["maxArtifactContentBytes"])

    def test_purge_gov_and_content_matches_the_uninstall_tombstone_contract(self) -> None:
        self.assertEqual(GOV_AND_CONTENT, ("installations", "workspaces", *LIMITS["uninstall"]["tombstoneTables"]))

    def test_job_status_transitions_accepted_by_updateAnalysisJobStatus_exactly_match_the_contract_table(self) -> None:
        statuses = ENUMS["analysis_jobs.status"]; accepted: list[tuple[str, str]] = []; n = 0
        for from_status in statuses:
            for to_status in statuses:
                job_id = f"job-{n}"; n += 1
                self.put("analysis_jobs", job_id, ownerWorkspaceId="w", projectId="p", type="bootstrap", status=from_status, attempts=0, idempotencyKey=f"bootstrap:{job_id}", error=None, warnings=[], warningsOverflow=0)
                try:
                    self.store.updateAnalysisJobStatus(RuleStoreContext("w", "u"), job_id, to_status)
                    accepted.append((from_status, to_status))
                except RuleStoreError as error:
                    self.assertEqual(error.code, "INVALID_STATUS_TRANSITION"); self.assertEqual(error.status, 422)
        expected = [(from_status, to_status) for from_status, tos in LIMITS["analysisJobs"]["validStatusTransitions"].items() for to_status in tos]
        self.assertEqual(sorted(accepted), sorted(expected))

    def test_validate_analysis_job_input_enforces_the_contracts_idempotency_key_length_payload_size_and_segment_counts(self) -> None:
        limits = LIMITS["analysisJobs"]
        ok_key = "bootstrap:" + "a" * (limits["maxIdempotencyKeyLength"] - len("bootstrap:"))
        self.assertEqual(len(ok_key), limits["maxIdempotencyKeyLength"])
        validateAnalysisJobInput({"type": "bootstrap", "projectId": "p", "payload": {"x": 1}, "idempotencyKey": ok_key})
        with self.assertRaises(RuleStoreError) as caught: validateAnalysisJobInput({"type": "bootstrap", "projectId": "p", "payload": {"x": 1}, "idempotencyKey": ok_key + "a"})
        self.assertEqual(caught.exception.code, "INVALID_IDEMPOTENCY_KEY")

        overhead = len(canonicalJson({"x": ""}).encode())
        oversized = {"x": "x" * (limits["maxPayloadBytes"] - overhead + 1)}
        with self.assertRaises(RuleStoreError) as caught: validateAnalysisJobInput({"type": "bootstrap", "projectId": "p", "payload": oversized, "idempotencyKey": "bootstrap:p"})
        self.assertEqual(caught.exception.code, "PAYLOAD_TOO_LARGE")

        for type_, counts in limits["idempotencyKeyParts"].items():
            for n in counts:
                validateAnalysisJobInput({"type": type_, "projectId": None if type_ == "purge" else "p", "payload": {"x": 1}, "idempotencyKey": build_key(type_, n)})
            with self.assertRaises(RuleStoreError) as caught: validateAnalysisJobInput({"type": type_, "projectId": None if type_ == "purge" else "p", "payload": {"x": 1}, "idempotencyKey": build_key(type_, max(counts) + 1)})
            self.assertEqual(caught.exception.code, "INVALID_IDEMPOTENCY_KEY")

    def test_validate_rule_version_input_enforces_the_contracts_byte_and_array_length_limits(self) -> None:
        limits = LIMITS["ruleVersions"]; max_evidence = LIMITS["limits"]["maxEvidencePerVersion"]
        base = {"content": "c", "rationale": "r", "changeType": "initial", "evidenceIds": [], "driftFindingIds": []}
        content_ok = "x" * limits["maxContentBytes"]
        _validate_rule_version_input({**base, "content": content_ok})
        with self.assertRaises(RuleStoreError) as caught: _validate_rule_version_input({**base, "content": content_ok + "x"})
        self.assertEqual(caught.exception.code, "INVALID_CONTENT")

        evidence_ok = [f"e{i}" for i in range(max_evidence)]
        _validate_rule_version_input({**base, "evidenceIds": evidence_ok})
        with self.assertRaises(RuleStoreError) as caught: _validate_rule_version_input({**base, "evidenceIds": [*evidence_ok, "extra"]})
        self.assertEqual(caught.exception.code, "INVALID_EVIDENCE_IDS")

        with self.assertRaises(RuleStoreError) as caught: _validate_rule_version_input({**base, "driftFindingIds": [f"f{i}" for i in range(limits["maxDriftFindingIds"] + 1)]})
        self.assertEqual(caught.exception.code, "INVALID_RULE_VERSION")
        with self.assertRaises(RuleStoreError) as caught: _validate_rule_version_input({**base, "aiSummary": "x" * (limits["maxAiSummaryBytes"] + 1)})
        self.assertEqual(caught.exception.code, "INVALID_AI_SUMMARY")
        with self.assertRaises(RuleStoreError) as caught: _validate_rule_version_input({**base, "rationale": "x" * (limits["maxRationaleBytes"] + 1)})
        self.assertEqual(caught.exception.code, "INVALID_RATIONALE")

    def test_purge_workspace_removes_every_contract_table_document(self) -> None:
        self.db.delete("projects", "p")
        tables = (*LIMITS["uninstall"]["tombstoneTables"], "rule_relations", "change_triggers", "resolution_snapshots", "revision_prs", "analysis_jobs")
        for table in tables: self.put(table, table, ownerWorkspaceId="w")
        result = self.store.purgeWorkspace(RuleStoreContext("w", None, "system"), "w")
        self.assertEqual(result["deletedCount"], len(tables))
        for table in tables: self.assertIsNone(self.db.get(table, table)[0])

    def test_k14_reinstall_cancellation_resets_every_contract_tombstone_table(self) -> None:
        stamp = "2024-01-01T00:00:00Z"
        self.put("installations", "old", ownerWorkspaceId="w", status="deleted", deletedAt=stamp, purgeScheduledAt="later")
        self.put("installations", "new", ownerWorkspaceId="w", status="active", deletedAt=None)
        tables = LIMITS["uninstall"]["tombstoneTables"]
        for table in tables: self.put(table, table, ownerWorkspaceId="w", deletedAt=stamp)
        result = PurgeJobHandler(self.store)({"id": "job", "ownerWorkspaceId": "w", "payload": {}}, Path("/tmp"))
        self.assertEqual(result, {"cancelled": True})
        for table in tables: self.assertIsNone(self.db.get(table, table)[0]["deletedAt"])

if __name__ == "__main__": unittest.main()
