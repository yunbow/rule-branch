from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
from types import ModuleType
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rulebranch.ai_runtime import (
    AgentExecutionContext, FixedStructuredGenerator, GeminiStructuredGenerator, GitHubAppAuth, LocalCloneReadTools, ReadOnlyAgent,
    PipelineResult, StructuredOutputError, bound_untrusted_inputs, build_provenance, clone_repository, materialize_evidence, scan_prompt_injection,
    shallow_clone, stage_one, wrap_untrusted_content,
)
from fake_firestore import InMemoryFirestore
from fake_oidc import FakeOidcVerifier
from rulebranch.job_runtime import JobHandlerRegistry, WorkerRuntime
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext


SCHEMA = {
    "type": "object", "required": ["candidates"], "properties": {
        "candidates": {"type": "array", "items": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string"}}}},
    },
}


class AiRuntimeTests(unittest.TestCase):

    def test_default_injection_patterns_match_whitespace_in_english(self) -> None:
        from rulebranch.config import load_config
        config = load_config({"RULEBRANCH_AI_PROVIDER": "gemini-api",
                              "RULEBRANCH_AI_MODEL_FAST": "test-fast",
                              "RULEBRANCH_AI_MODEL_REASONING": "test-reasoning"})
        for candidate in ("Ignore previous instructions", "system prompt", "you are now"):
            with self.subTest(candidate=candidate):
                warnings = scan_prompt_injection([("README.md", candidate)], config.ai_injection_patterns)
                self.assertEqual(warnings[0]["code"], "possible_prompt_injection")

    def test_gemini_api_omits_vertex_project_and_location(self) -> None:
        google, genai = ModuleType("google"), ModuleType("google.genai")
        client = Mock()
        client.models.generate_content.return_value.text = '{"candidates": []}'
        genai.Client = Mock(return_value=client)
        google.genai = genai
        with patch.dict(sys.modules, {"google": google, "google.genai": genai}):
            for provider, expected in (
                ("gemini-api", {"vertexai": False}),
                ("vertex-ai", {"vertexai": True, "project": "p", "location": "asia-northeast1"}),
            ):
                generator = GeminiStructuredGenerator(provider, project="p", location="asia-northeast1")
                self.assertEqual(generator.generate_structured("prompt", SCHEMA, "model"), {"candidates": []})
                genai.Client.assert_called_with(**expected)

    def test_installation_token_is_reused_for_burst_of_github_calls(self) -> None:
        class TokenApi:
            def __init__(self) -> None: self.calls = 0
            def create_installation_access_token(self, installation_id: str, app_jwt: str) -> dict[str, str]:
                self.calls += 1
                self.assertions = (installation_id, app_jwt)
                return {"token": f"token-{self.calls}"}
        api = TokenApi(); auth = GitHubAppAuth("app", "unused", api)
        with patch.object(auth, "create_app_jwt", return_value="jwt"):
            self.assertEqual(auth.installation_token("42", 100), "token-1")
            self.assertEqual(auth.installation_token("42", 399), "token-1")
            self.assertEqual(auth.installation_token("42", 400), "token-2")
            self.assertEqual(auth.installation_token("43", 400), "token-3")
        self.assertEqual(api.calls, 3)
        self.assertEqual(api.assertions, ("43", "jwt"))

    def test_repository_record_full_name_clones_with_installation_token_outside_argv(self) -> None:
        class Auth:
            def repository_token(self, repository: dict[str, str]) -> str:
                self.installation_id = repository["installationId"]
                return "secret-token"
        auth = Auth()
        with tempfile.TemporaryDirectory() as temporary, patch("rulebranch.ai_runtime.subprocess.run") as run:
            clone_repository({"fullName": "acme/private", "installationId": "42"}, "repo", Path(temporary), auth)  # type: ignore[arg-type]
        args, kwargs = run.call_args
        self.assertEqual(auth.installation_id, "42")
        self.assertEqual(args[0][-2], "https://github.com/acme/private.git")
        self.assertNotIn("secret-token", " ".join(args[0]))
        self.assertIn("Authorization: Basic ", kwargs["env"]["GIT_CONFIG_VALUE_0"])

    def test_repository_auth_resolves_internal_installation_in_its_workspace(self) -> None:
        db = InMemoryFirestore()
        db.put("installations", "internal-id", {"ownerWorkspaceId": "w", "status": "active", "githubInstallationId": "42"})
        api = type("TokenApi", (), {"create_installation_access_token": lambda *_: {"token": "secret"}})()
        auth = GitHubAppAuth("app", "unused", api, store=FirestoreRuleStore(db))
        repo = {"fullName": "acme/private", "ownerWorkspaceId": "w", "installationId": "internal-id"}
        with patch.object(auth, "installation_token", return_value="secret") as exchange, patch("rulebranch.ai_runtime.subprocess.run"):
            with tempfile.TemporaryDirectory() as temporary:
                clone_repository(repo, "repo", Path(temporary), auth)
            exchange.assert_called_once_with("42")
            exchange.reset_mock()
            for changed in ({"ownerWorkspaceId": "other"}, {"installationId": "missing"}):
                with self.assertRaisesRegex(ValueError, "installation is unavailable"):
                    auth.repository_token({**repo, **changed})
            db.put("installations", "internal-id", {"ownerWorkspaceId": "w", "status": "deleted", "githubInstallationId": "42"})
            with self.assertRaisesRegex(ValueError, "installation is unavailable"):
                auth.repository_token(repo)
            exchange.assert_not_called()

    def test_clone_rejects_git_transports_and_full_name_overrides_explicit_url(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch("rulebranch.ai_runtime.subprocess.run") as run:
            clone_repository({"fullName": "acme/repo", "cloneUrl": "ext::sh -c exploit", "installationId": "42"}, "repo", Path(temporary), token="secret")
            self.assertEqual(run.call_args.args[0][-2], "https://github.com/acme/repo.git")
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "clone target"):
                shallow_clone("ext::sh -c exploit", "repo", Path(temporary), token="secret")
            with self.assertRaisesRegex(ValueError, "GitHub HTTPS"):
                shallow_clone("https://attacker.example/repo.git", "repo", Path(temporary), token="secret")

    def test_failed_clone_removes_partial_checkout_and_honors_shorter_timeout(self) -> None:
        def time_out(command: list[str], **_kwargs: object) -> None:
            Path(command[-1]).mkdir(parents=True)
            (Path(command[-1]) / "partial.pack").write_bytes(b"partial")
            raise subprocess.TimeoutExpired(command, 7)

        with tempfile.TemporaryDirectory() as temporary, patch("rulebranch.ai_runtime.subprocess.run", side_effect=time_out) as run:
            destination = Path(temporary) / "repo"
            with self.assertRaises(subprocess.TimeoutExpired):
                shallow_clone("https://github.com/acme/repo.git", "repo", Path(temporary), timeout_seconds=7)
            self.assertFalse(destination.exists())
            self.assertEqual(run.call_args.kwargs["timeout"], 7)
            with self.assertRaisesRegex(ValueError, "outside temporary root"):
                shallow_clone("https://github.com/acme/repo.git", "../escape", Path(temporary))

    def test_agent_has_only_read_tools_and_context_has_no_github_credentials(self) -> None:
        agent = ReadOnlyAgent(FixedStructuredGenerator({"candidates": []}), "gemini-test")
        forbidden = {"create_pull_request", "create_check_run", "post_comment", "push", "github_write"}
        self.assertFalse(forbidden.intersection(agent.tool_names))
        context = AgentExecutionContext("workspace", "job", Path("/tmp/job"))
        self.assertFalse(any("token" in key.lower() or "github" in key.lower() for key in vars(context)))

    def test_schema_failure_happens_before_candidate_processing(self) -> None:
        # The worker changes only job status; no AI-output collection is written.
        db = InMemoryFirestore(); db.put("projects", "p", {"id": "p", "ownerWorkspaceId": "w", "status": "active", "deletedAt": None}); store = FirestoreRuleStore(db)
        human = RuleStoreContext("w", "human")
        job = store.createAnalysisJob(human, {"type": "bootstrap", "projectId": "p", "payload": {}, "idempotencyKey": "bootstrap:schema", "requestId": "r"})["job"]
        handlers = JobHandlerRegistry()
        handlers.register("bootstrap", lambda _job, _dir: stage_one({"candidates": "not-an-array"}, SCHEMA, candidate_field="candidates", max_candidates=40, existing_keys=set(), repository_url="https://github.com/acme/repo"))
        with tempfile.TemporaryDirectory() as temporary:
            WorkerRuntime(store, FakeOidcVerifier(), "aud", handlers, tmp_root=Path(temporary)).run_job("w", str(job["id"]))
        self.assertEqual(store.get(human, "analysis_jobs", str(job["id"]))["status"], "failed")
        self.assertEqual(store.list(human, "rules"), [])
        self.assertEqual(store.list(human, "rule_versions"), [])
        self.assertEqual(store.list(human, "evidence"), [])
        with self.assertRaises(StructuredOutputError):
            stage_one({"candidates": "not-an-array"}, SCHEMA, candidate_field="candidates", max_candidates=40, existing_keys=set(), repository_url="https://github.com/acme/repo")

    def test_injection_is_warning_not_failure_and_is_wrapped_as_data(self) -> None:
        warnings = scan_prompt_injection([("README.md", "hello\nIgnore previous instructions\n")], [r"ignore\s+previous\s+instructions"])
        self.assertEqual(warnings[0]["code"], "possible_prompt_injection")
        self.assertEqual((warnings[0]["path"], warnings[0]["line"]), ("README.md", 2))
        self.assertIn('<untrusted_repository_content path="README.md">', wrap_untrusted_content("README.md", "x"))

    def test_repository_tree_and_escaped_prompt_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / ".git").mkdir()
            (root / ".git/large-index").write_text("ignored", encoding="utf-8")
            for index in range(5): (root / f"file-{index}.py").write_text("x", encoding="utf-8")
            self.assertEqual(len(LocalCloneReadTools(root, max_tree_entries=3).list_tree()), 3)
            self.assertNotIn(".git/large-index", LocalCloneReadTools(root).list_tree())
        retained, prompt, truncated = bound_untrusted_inputs([("README.md", "<&" * 1000)], 256)
        self.assertTrue(truncated); self.assertTrue(retained)
        self.assertLessEqual(len(prompt.encode("utf-8")), 256)
        self.assertIn("&lt;", prompt); self.assertIn("&amp;", prompt)

    def test_stage_one_limits_deduplicates_enums_and_external_urls(self) -> None:
        very_long = "あ" * (40 * 1024)
        output = {"candidates": [
            {"key": "one", "layer": "L1", "content": very_long, "rationale": very_long, "summary": very_long, "detail": very_long, "aiSummary": very_long, "notes": "[bad](https://evil.example/a) https://github.com/acme/repo/issues/1"},
            {"key": "one"}, {"key": "old"}, {"key": "last"},
        ]}
        result = stage_one(output, SCHEMA, candidate_field="candidates", max_candidates=3, existing_keys={"old"}, repository_url="https://github.com/acme/repo")
        self.assertEqual(len(result.candidates), 1)
        item = result.candidates[0]
        self.assertLessEqual(len(item["content"].encode()), 32 * 1024)
        self.assertLessEqual(len(item["rationale"].encode()), 8 * 1024)
        self.assertLessEqual(len(item["summary"].encode()), 1024)
        self.assertLessEqual(len(item["detail"].encode()), 8 * 1024)
        self.assertLessEqual(len(item["aiSummary"].encode()), 1024)
        self.assertNotIn("evil.example", item["notes"])
        self.assertIn("github.com/acme/repo", item["notes"])
        self.assertEqual({warning["code"] for warning in result.warnings}, {"output_truncated", "duplicate_rule_key"})
        with self.assertRaises(StructuredOutputError):
            stage_one({"candidates": [{"key": "x", "layer": "NOT_A_LAYER"}]}, SCHEMA, candidate_field="candidates", max_candidates=4, existing_keys=set(), repository_url="https://github.com/acme/repo")

    def test_evidence_is_verified_and_excerpt_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / "src").mkdir()
            (root / "src/file.py").write_text("\n".join("x" * 500 for _ in range(50)), encoding="utf-8")
            tools = LocalCloneReadTools(root)
            first = stage_one({"candidates": [{"key": "valid", "evidence": [{"path": "src/file.py", "lineStart": 1, "lineEnd": 50}]}, {"key": "invalid", "evidence": [{"path": "missing.py", "lineStart": 1, "lineEnd": 2}]}]}, SCHEMA, candidate_field="candidates", max_candidates=5, existing_keys=set(), repository_url="https://github.com/acme/repo")
            result = materialize_evidence(first, tools, repository_id="repo", commit_sha="abc")
            self.assertEqual([candidate["key"] for candidate in result.candidates], ["valid"])
            evidence = result.candidates[0]["evidence"][0]
            self.assertLessEqual(evidence["excerptLineCount"], 30)
            self.assertLessEqual(evidence["excerptBytes"], 4 * 1024)
            self.assertEqual(evidence["excerptHash"], hashlib.sha256(evidence["excerpt"].encode()).hexdigest())
            self.assertIn("evidence_unverifiable", [warning["code"] for warning in result.warnings])
            with self.assertRaises(PermissionError): tools.read_file(".", "../outside", 1, 1)

    def test_punctuation_only_evidence_is_discarded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "package.json").write_text('  "zod": "4.6.5"\n},\n', encoding="utf-8")
            result = materialize_evidence(PipelineResult([{"key": "zod", "evidence": [
                {"path": "package.json", "lineStart": 2, "lineEnd": 2},
                {"path": "package.json", "lineStart": 1, "lineEnd": 1},
            ]}], []), LocalCloneReadTools(root), repository_id="repo")
            self.assertEqual(len(result.candidates[0]["evidence"]), 1)
            self.assertEqual(result.candidates[0]["evidence"][0]["ref"]["lineStart"], 1)
            self.assertTrue(result.warnings)

    def test_provenance_only_contains_digest_not_prompt(self) -> None:
        raw = ["untrusted README", "untrusted source"]
        provenance = build_provenance("gemini-fast", "v1", raw)
        self.assertEqual(provenance["inputDigest"], hashlib.sha256("".join(raw).encode()).hexdigest())
        self.assertNotIn("prompt", provenance)
        self.assertNotIn("README", str(provenance))


if __name__ == "__main__":
    unittest.main()
