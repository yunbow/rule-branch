from __future__ import annotations
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError

CTX = RuleStoreContext("workspace-a", "user-a")
GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "rule_resolver_golden.json").read_text())

class ResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = InMemoryFirestore(); self.store = FirestoreRuleStore(self.db)
        self.db.put("projects", "project", {"id": "project", "ownerWorkspaceId": "workspace-a"})
        self.db.put("repositories", "repo", {"id": "repo", "ownerWorkspaceId": "workspace-a", "projectId": "project", "status": "active"})

    def rule(self, id: str, scope: str, **extra: object) -> None:
        version = f"v-{id}"
        self.db.put("rules", id, {"id": id, "ownerWorkspaceId": "workspace-a", "scopeType": scope, "scopeId": "workspace-a" if scope == "organization" else ("project" if scope == "project" else "user-a"), "projectId": "project" if scope == "project" else None, "status": "active", "enforcement": "default", "layer": "L2", "key": id, "selector": {"languages": [], "frameworks": [], "directoryGlobs": [], "dependencies": [], "repositoryIds": []}, "currentVersionId": version, **extra})
        self.db.put("rule_versions", version, {"id": version, "ownerWorkspaceId": "workspace-a", "ruleId": id})

    def relation(self, kind: str) -> None:
        self.db.put("rule_relations", "relation", {"id": "relation", "ownerWorkspaceId": "workspace-a", "parentRuleId": "parent", "childRuleId": "child", "relationType": kind})

    def ids(self, snapshot: dict[str, object]) -> list[str]: return [str(value)[2:] for value in snapshot["ruleVersionIds"]]  # type: ignore[index]

    def test_golden_relation_scenarios(self) -> None:
        cases = {case["name"]: case for case in GOLDEN["scenarios"]}
        for name in ("override", "extend", "deny"):
            with self.subTest(name=name):
                self.setUp(); self.rule("parent", "organization"); self.rule("child", "project"); self.relation(str(cases[name]["relationType"]))
                self.assertEqual(self.ids(self.store.resolveRules(CTX, "project", "repo")), cases[name]["expectedRuleIds"])

    def test_conflict_repository_and_personal_golden_scenarios(self) -> None:
        cases = {case["name"]: case for case in GOLDEN["scenarios"]}
        self.rule("one", "organization", key="duplicate"); self.rule("two", "project", key="duplicate")
        snapshot = self.store.resolveRules(CTX, "project", "repo")
        self.assertEqual(len(snapshot["conflicts"]), cases["conflict"]["expectedConflicts"])
        self.setUp(); self.rule("limited", "project", selector={"repositoryIds": cases["repository-filter"]["repositoryIds"]})
        self.assertEqual(self.ids(self.store.resolveRules(CTX, "project", "repo")), cases["repository-filter"]["expectedRuleIds"])
        self.setUp(); self.rule("personal", "user", enforcement="personal")
        snapshot = self.store.resolveRules(CTX, "project", "repo", "user-a")
        self.assertEqual([item["ruleId"] for item in snapshot["presentation"]], cases["personal"]["expectedPresentationRuleIds"])
        self.assertEqual(snapshot["ruleVersionIds"], [])

    def test_limit_does_not_create_snapshot_and_order_is_deterministic(self) -> None:
        limit = next(case for case in GOLDEN["scenarios"] if case["name"] == "limit")
        for index in range(int(limit["ruleCount"])): self.rule(f"r{index}", "project", key=f"k{index}")
        with self.assertRaises(RuleStoreError) as caught: self.store.resolveRules(CTX, "project", "repo")
        self.assertEqual(caught.exception.code, limit["expectedError"]); self.assertEqual(self.store.list(CTX, "resolution_snapshots"), [])
        self.setUp(); self.rule("z", "organization", layer="L2", enforcement="advisory", key="z"); self.rule("a", "organization", layer="L1", enforcement="locked", key="a")
        self.assertEqual(self.store.resolveRules(CTX, "project", "repo")["ruleVersionIds"], self.store.resolveRules(CTX, "project", "repo")["ruleVersionIds"])

    def test_status_selector_and_removed_repository(self) -> None:
        for status in ("draft", "deprecated", "superseded", "archived"): self.rule(status, "project", status=status)
        self.rule("language", "project", selector={"languages": ["Python"]})
        self.assertEqual(self.ids(self.store.resolveRules(CTX, "project", "repo", selector={"languages": ["python"]})), ["language"])
        self.db.put("repositories", "repo", {"id": "repo", "ownerWorkspaceId": "workspace-a", "projectId": "project", "status": "removed"})
        self.assertEqual(self.store.resolveRules(CTX, "project", "repo")["ruleVersionIds"], [])

if __name__ == "__main__": unittest.main()
