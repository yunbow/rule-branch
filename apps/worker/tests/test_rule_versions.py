from __future__ import annotations
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError

CTX = RuleStoreContext("workspace-a", "user-a")
class RuleVersionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db, self.store = InMemoryFirestore(), FirestoreRuleStore(InMemoryFirestore())
        self.db = self.store._firestore
        self.db.put("rules", "rule", {"id": "rule", "ownerWorkspaceId": "workspace-a", "scopeType": "organization", "scopeId": "workspace-a", "visibility": "private", "enforcement": "default", "transferPolicy": "exportable", "licenseType": "proprietary-customer", "provenance": {"sourceType": "human"}, "status": "draft", "nextVersion": 1})
    def input(self, **extra: object) -> dict[str, object]: return {"content": "body", "rationale": "why", "changeType": "initial", **extra}
    def test_allocates_monotonically_and_ai_requires_evidence(self) -> None:
        first = self.store.createRuleVersion(CTX, "rule", self.input()); second = self.store.createRuleVersion(CTX, "rule", self.input(changeType="clarify"))
        self.assertEqual((first["version"], second["version"]), (1, 2)); self.assertEqual(self.store.get(CTX, "rules", "rule")["nextVersion"], 3)
        with self.assertRaises(RuleStoreError) as caught: self.store.createRuleVersion(CTX, "rule", self.input(provenance={"sourceType": "ai"}))
        self.assertEqual(caught.exception.code, "EVIDENCE_REQUIRED")
    def test_supersedes_withdraws_and_repoints_d8(self) -> None:
        old = self.store.createRuleVersion(CTX, "rule", self.input()); self.db.put("drift_findings", "f", {"id": "f", "ownerWorkspaceId": "workspace-a", "proposalVersionId": old["id"]})
        new = self.store.createRuleVersion(CTX, "rule", self.input(changeType="clarify", supersedes=old["id"]))
        self.assertEqual(self.store.get(CTX, "rule_versions", old["id"])["status"], "withdrawn"); self.assertEqual(self.store.get(CTX, "drift_findings", "f")["proposalVersionId"], new["id"])
if __name__ == "__main__": unittest.main()
