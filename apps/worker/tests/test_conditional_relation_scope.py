from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rulebranch.compiler import compile as compile_rules
from rulebranch.relation_scope import uncovered_relation_fields
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext, RuleStoreError

CTX = RuleStoreContext("workspace", "owner")


class ResolverHarness(FirestoreRuleStore):
    """Exercise the production resolver; replace storage, not rule resolution."""
    def __init__(self, parent=None, child=None, kind="override"):
        self.snapshots = []
        self.project = {"id": "project", "ownerWorkspaceId": "workspace"}
        self.repository = {"id": "repo", "ownerWorkspaceId": "workspace", "projectId": "project", "status": "active",
                           "compileTargets": ["agents-md", "claude-md", "copilot-instructions", "rulebranch-rules"]}
        self.rules = [self.rule("parent", "organization", parent or {}), self.rule("child", "project", child or {})]
        self.relations = [{"id": "relation", "parentRuleId": "parent", "childRuleId": "child", "relationType": kind, "rationale": "exception"}]
        self.versions = [{"id": "v-" + rule["id"], "ruleId": rule["id"], "status": "approved", "content": rule["id"] + " policy"}
                         for rule in self.rules]

    @staticmethod
    def rule(id, scope, selector):
        return {"id": id, "ownerWorkspaceId": "workspace", "scopeType": scope, "scopeId": "workspace" if scope == "organization" else "project",
                "projectId": None if scope == "organization" else "project", "selector": selector,
                "status": "active", "currentVersionId": "v-" + id, "key": id, "layer": "L2", "enforcement": "default"}

    def get(self, ctx, collection, id):
        if collection == "projects":
            return copy.deepcopy(self.project)
        if collection == "repositories":
            return copy.deepcopy(self.repository)
        raise AssertionError(collection)

    def list(self, ctx, collection, filter=None):
        return copy.deepcopy({"rules": self.rules, "rule_relations": self.relations}[collection])

    def _get_many(self, ctx, collection, ids):
        assert collection == "rule_versions"
        return copy.deepcopy([version for version in self.versions if version["id"] in ids])

    def _save_resolution_snapshot(self, ctx, project_id, repository_id, user_id, selector, entries, conflicts, presentation):
        snapshot = {"id": "snapshot", "selector": selector, "ruleVersionIds": [entry["version"]["id"] for entry in entries], "conflicts": conflicts}
        self.snapshots.append(snapshot)
        return snapshot

    def resolve(self, selector=None):
        return self.resolveRules(CTX, "project", "repo", selector=selector)

    def compile(self, snapshot):
        return compile_rules({"resolutionSnapshot": snapshot, "rules": self.rules, "ruleVersions": self.versions,
                              "ruleRelations": self.relations, "repository": self.repository})


class ConditionalScopeTests(unittest.TestCase):
    def test_shared_web_worker_relation_coverage_contract(self):
        fixture = Path(__file__).resolve().parents[3] / "contracts" / "relation-coverage.json"
        cases = json.loads(fixture.read_text())
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertEqual(uncovered_relation_fields(case["parent"], case["child"]), case["uncovered"])

    def test_no_context_constraint_or_repository_only(self):
        self.assertEqual(uncovered_relation_fields({}, {}), [])
        self.assertEqual(uncovered_relation_fields({}, {"repositoryIds": ["repo"]}), [])

    def test_same_scope_case_normalization_and_superset(self):
        self.assertEqual(uncovered_relation_fields({"languages": ["Python"], "frameworks": ["React"]},
                                                  {"languages": ["PYTHON", "Go"], "frameworks": ["react"]}), [])
        self.assertEqual(uncovered_relation_fields({"directoryGlobs": ["legacy/**"]}, {"directoryGlobs": ["legacy/**", "test/**"]}), [])

    def test_glob_overlap_is_not_coverage(self):
        self.assertEqual(uncovered_relation_fields({"directoryGlobs": ["**"]}, {"directoryGlobs": ["legacy/**"]}), ["directoryGlobs"])
        self.assertEqual(uncovered_relation_fields({}, {"directoryGlobs": ["legacy/**"]}, {"directoryGlobs": ["**"]}), ["directoryGlobs"])

    def test_partial_context_is_not_coverage(self):
        self.assertEqual(uncovered_relation_fields({}, {"languages": ["Python"], "directoryGlobs": ["legacy/**"]},
                                                  {"directoryGlobs": ["legacy/a.py"]}), ["languages"])

    def test_mixed_request_must_be_wholly_covered(self):
        self.assertEqual(uncovered_relation_fields({}, {"languages": ["Python"]}, {"languages": ["Python", "Go"]}), ["languages"])
        self.assertEqual(uncovered_relation_fields({}, {"directoryGlobs": ["legacy/**"]},
                                                  {"directoryGlobs": ["legacy/a.py", "src/a.py"]}), ["directoryGlobs"])

    def test_dependency_names_remain_case_sensitive(self):
        self.assertEqual(uncovered_relation_fields({"dependencies": ["Zod"]}, {"dependencies": ["zod"]}), ["dependencies"])

    def test_invalid_selector_is_not_silently_treated_as_global(self):
        for value in ("Python", 123, [123], {"name": "Python"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                uncovered_relation_fields({}, {"languages": value})

    def test_global_context_does_not_drop_parent(self):
        for kind in ("override", "deny"):
            for field, values in (("directoryGlobs", ["legacy/**"]), ("languages", ["Python"]),
                                  ("frameworks", ["react"]), ("dependencies", ["zod"])):
                for request in (None, {}):
                    with self.subTest(kind=kind, field=field, request=request):
                        store = ResolverHarness(child={field: values}, kind=kind)
                        before = copy.deepcopy(store.rules)
                        with self.assertRaises(RuleStoreError) as caught:
                            store.resolve(request)
                        self.assertEqual(caught.exception.code, "CONDITIONAL_RELATION_UNSUPPORTED")
                        self.assertEqual(caught.exception.status, 422)
                        self.assertEqual(caught.exception.details["fields"], [field])
                        self.assertEqual(store.snapshots, [])
                        self.assertEqual(store.rules, before)

    def test_scoped_resolution_inside_and_outside_exception(self):
        for kind in ("override", "deny"):
            with self.subTest(kind=kind):
                store = ResolverHarness(child={"directoryGlobs": ["legacy/**"]}, kind=kind)
                self.assertEqual(store.resolve({"directoryGlobs": ["src/new.py"]})["ruleVersionIds"], ["v-parent"])
                self.assertEqual(store.resolve({"directoryGlobs": ["legacy/old.py"]})["ruleVersionIds"], ["v-child"])
                with self.assertRaises(RuleStoreError):
                    store.resolve({"directoryGlobs": ["**"]})

    def test_compiler_rejects_stale_and_scoped_snapshots(self):
        for kind in ("override", "deny"):
            for ids in (["v-parent", "v-child"], ["v-child"]):
                with self.subTest(kind=kind, ids=ids):
                    store = ResolverHarness(child={"directoryGlobs": ["legacy/**"]}, kind=kind)
                    with self.assertRaisesRegex(ValueError, "CONDITIONAL_RELATION_UNSUPPORTED"):
                        store.compile({"ruleVersionIds": ids, "selector": {"directoryGlobs": ["legacy/old.py"]}})

    def test_same_scope_still_compiles_override_and_deny(self):
        for kind in ("override", "deny"):
            with self.subTest(kind=kind):
                scope = {"directoryGlobs": ["legacy/**"]}
                store = ResolverHarness(parent=scope, child=scope, kind=kind)
                snapshot = store.resolve()
                self.assertEqual(snapshot["ruleVersionIds"], ["v-child"])
                artifacts = store.compile(snapshot)
                content = next(item.content for item in artifacts if item.path == "AGENTS.md")
                self.assertIn("child policy", content)
                self.assertNotIn("parent policy", content)
                self.assertIn("legacy/**", content)
                self.assertEqual(any(item.path.endswith("_denied.md") for item in artifacts), kind == "deny")

    def test_repository_scoped_relations_keep_other_repositories_unchanged(self):
        for kind in ("override", "deny"):
            with self.subTest(kind=kind):
                store = ResolverHarness(child={"repositoryIds": ["repo"]}, kind=kind)
                self.assertEqual(store.resolve()["ruleVersionIds"], ["v-child"])
                store.repository["id"] = "other-repo"
                snapshot = store.resolveRules(CTX, "project", "other-repo")
                self.assertEqual(snapshot["ruleVersionIds"], ["v-parent"])
                self.assertIn("parent policy", store.compile(snapshot)[0].content)

    def test_extend_keeps_both_policies(self):
        store = ResolverHarness(child={"directoryGlobs": ["legacy/**"]}, kind="extend")
        snapshot = store.resolve()
        self.assertEqual(set(snapshot["ruleVersionIds"]), {"v-parent", "v-child"})
        content = store.compile(snapshot)[0].content
        self.assertIn("parent policy", content)
        self.assertIn("child policy", content)

    def test_inactive_parent_and_unrelated_relations_do_not_block(self):
        store = ResolverHarness(child={"directoryGlobs": ["legacy/**"]})
        store.rules[0]["status"] = "deprecated"
        self.assertEqual(store.resolve()["ruleVersionIds"], ["v-child"])
        self.assertTrue(store.compile(store.resolve()))
        store = ResolverHarness(child={"directoryGlobs": ["legacy/**"], "repositoryIds": ["other"]})
        self.assertEqual(store.resolve()["ruleVersionIds"], ["v-parent"])
        self.assertTrue(store.compile(store.resolve()))


if __name__ == "__main__":
    unittest.main()
