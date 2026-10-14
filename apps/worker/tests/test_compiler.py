from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rulebranch.compiler import COMPILER_VERSION, HEADER, compile


class CompilerTests(unittest.TestCase):
    def source(self, *, targets: list[str] | None = None, content: str = "Use typed APIs.") -> dict[str, object]:
        rules = [
            {"id": "locked", "key": "security", "layer": "L1", "enforcement": "locked", "currentVersionId": "v-locked"},
            {"id": "child", "key": "style", "layer": "L2", "enforcement": "default", "currentVersionId": "v-child"},
            {"id": "advice", "key": "tips", "layer": "L3", "enforcement": "advisory", "currentVersionId": "v-advice"},
            {"id": "personal", "key": "personal", "layer": "L3", "enforcement": "personal", "currentVersionId": "v-personal"},
            {"id": "denied", "key": "old-style", "layer": "L2", "enforcement": "default", "currentVersionId": "v-denied"},
        ]
        versions = [
            {"id": "v-locked", "ruleId": "locked", "content": content},
            {"id": "v-child", "ruleId": "child", "content": "Use formatting."},
            {"id": "v-advice", "ruleId": "advice", "content": "Prefer small functions."},
            {"id": "v-personal", "ruleId": "personal", "content": "Never publish this."},
            {"id": "v-denied", "ruleId": "denied", "content": "Old instruction."},
        ]
        return {
            "resolutionSnapshot": {"ruleVersionIds": ["v-locked", "v-child", "v-advice", "v-personal"], "resolvedRules": [{"ruleVersionId": "v-child", "resolvedVia": "deny"}], "conflicts": [{"ruleId": "locked", "conflictingRuleId": "child", "reason": "same_key_and_selector"}]},
            "rules": rules,
            "ruleVersions": versions,
            "ruleRelations": [
                {"parentRuleId": "denied", "childRuleId": "child", "relationType": "deny", "rationale": "Replaced by the project convention."},
            ],
            "repository": {"compileTargets": targets or ["agents-md", "claude-md", "copilot-instructions", "rulebranch-rules"], "rulesPath": ".rulebranch/rules"},
        }

    def test_deterministic_headers_relations_conflicts_and_personal_exclusion(self) -> None:
        first, second = compile(self.source()), compile(self.source())
        self.assertEqual([item.contentHash for item in first], [item.contentHash for item in second])
        self.assertTrue(all(item.compilerVersion == COMPILER_VERSION for item in first))
        self.assertTrue(all(item.content is None or HEADER in item.content for item in first))
        combined = "\n".join(item.content or "" for item in first)
        self.assertNotIn("Never publish this.", combined)
        self.assertIn("WARNING: Rule locked conflicts", combined)
        denied = next(item for item in first if item.path.endswith("_denied.md"))
        self.assertIn("Replaced by the project convention.", denied.content or "")
        self.assertNotIn("Old instruction.", next(item for item in first if item.path == "AGENTS.md").content or "")
        self.assertIn("## 推奨", next(item for item in first if item.path == "AGENTS.md").content or "")
        self.assertIn("**Enforcement: locked**", combined)

    def test_language_framework_path_and_dependency_scope_is_visible_in_generated_guidance(self) -> None:
        source = self.source(targets=["agents-md", "rulebranch-rules"])
        # Scope rendering is independent of relations that exclude a parent rule.
        source["ruleRelations"] = []
        child = next(rule for rule in source["rules"] if rule["id"] == "child")
        child["selector"] = {
            "languages": ["TypeScript"], "frameworks": ["Next.js"],
            "directoryGlobs": ["apps/web/**"], "dependencies": ["zod"],
            "repositoryIds": ["repo-1"]
        }
        output = compile(source)
        for artifact in output:
            if artifact.path == "AGENTS.md" or artifact.path.endswith("/L2/style.md"):
                body = artifact.publicationContent
                self.assertIn("適用条件（この条件に該当する場合のみ適用）", body)
                for value in ("TypeScript", "Next.js", "apps/web/**", "zod"):
                    self.assertIn(value, body)
                self.assertNotIn("repo-1", body)  # Repository IDs are already resolved.
        unscoped = compile(self.source(targets=["agents-md"]))[0].publicationContent
        self.assertNotIn("適用条件（この条件に該当する場合のみ適用）", unscoped)

    def test_git_blob_sha_matches_git_hash_object(self) -> None:
        artifact = next(item for item in compile(self.source(targets=["agents-md"])) if item.path == "AGENTS.md")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.md"; path.write_text(artifact.content or "", encoding="utf-8", newline="\n")
            actual = subprocess.check_output(["git", "hash-object", str(path)], text=True).strip()
        self.assertEqual(artifact.gitBlobSha, actual)

    def test_large_content_omits_body_but_retains_hash(self) -> None:
        artifact = next(item for item in compile(self.source(targets=["agents-md"], content="x" * (200 * 1024 + 1))) if item.path == "AGENTS.md")
        self.assertIsNone(artifact.content)
        self.assertTrue(artifact.contentOmitted)
        self.assertEqual(len(artifact.contentHash), 64)
        self.assertGreater(len(artifact.publicationContent.encode()), 200 * 1024)
        self.assertEqual(artifact.gitBlobSha, __import__("rulebranch.compiler", fromlist=["git_blob_sha"]).git_blob_sha(artifact.publicationContent))

    def test_targets_and_per_rule_paths(self) -> None:
        only_agents = compile(self.source(targets=["agents-md"]))
        self.assertEqual([item.path for item in only_agents], ["AGENTS.md"])
        artifacts = compile(self.source(targets=["rulebranch-rules"]))
        files = {item.path: item for item in artifacts}
        self.assertIn(".rulebranch/rules/L1/security.md", files)
        self.assertEqual(files[".rulebranch/rules/L1/security.md"].ruleId, "locked")
        self.assertIsNone(files[".rulebranch/rules/_denied.md"].ruleId)

    def test_duplicate_key_between_scopes_emits_unique_per_rule_files(self) -> None:
        source = self.source(targets=["rulebranch-rules"])
        source["rules"].append({"id": "org-copy", "key": "style", "layer": "L2", "enforcement": "default", "scopeType": "organization", "currentVersionId": "org-version"})
        source["ruleVersions"].append({"id": "org-version", "ruleId": "org-copy", "content": "Organization convention."})
        source["resolutionSnapshot"]["ruleVersionIds"].append("org-version")
        artifacts = compile(source)
        paths = [artifact.path for artifact in artifacts]
        self.assertEqual(len(paths), len(set(paths)))
        by_id = {artifact.ruleId: artifact for artifact in artifacts if artifact.ruleId}
        self.assertNotEqual(by_id["child"].path, by_id["org-copy"].path)
        self.assertIn("Use formatting.", by_id["child"].publicationContent)
        self.assertIn("Organization convention.", by_id["org-copy"].publicationContent)

    def test_no_denied_artifact_when_no_deny_relation(self) -> None:
        input = self.source(targets=["rulebranch-rules"])
        input["ruleRelations"] = []
        self.assertFalse(any(item.path.endswith("_denied.md") for item in compile(input)))

    def test_deny_relation_not_applied_by_resolver_is_not_published(self) -> None:
        input = self.source(targets=["rulebranch-rules"])
        input["resolutionSnapshot"]["resolvedRules"] = [
            {"ruleVersionId": "v-child", "resolvedVia": "inherit"},
        ]
        self.assertFalse(any(item.path.endswith("_denied.md") for item in compile(input)))

    def test_override_annotation_and_extend_snapshot_order(self) -> None:
        overridden = self.source(targets=["agents-md"])
        overridden["resolutionSnapshot"] = {"ruleVersionIds": ["v-denied", "v-child"], "conflicts": []}
        overridden["ruleRelations"] = [{"parentRuleId": "denied", "childRuleId": "child", "relationType": "override"}]
        content = compile(overridden)[0].content or ""
        self.assertIn("Rule denied overridden by child", content)
        self.assertNotIn("Old instruction.", content)

        extended = self.source(targets=["agents-md"])
        extended["resolutionSnapshot"] = {"ruleVersionIds": ["v-child", "v-locked"], "conflicts": []}
        extended["ruleRelations"] = [{"parentRuleId": "child", "childRuleId": "locked", "relationType": "extend"}]
        content = compile(extended)[0].content or ""
        self.assertLess(content.index("Use formatting."), content.index("Use typed APIs."))


if __name__ == "__main__":
    unittest.main()

