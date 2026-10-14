from __future__ import annotations
import importlib.util, io, json, sys, unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rulebranch.github_rest import RestGitDataApi, RestGitTreeApi
from rulebranch.job_runtime import JobHandlerRegistry, WorkerRuntime
from rulebranch.main import build_runtime, handler_factory
from rulebranch.rulestore import FirestoreRuleStore
from fake_firestore import InMemoryFirestore

RUN_LOCAL_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_local.py"
spec = importlib.util.spec_from_file_location("impl_019_run_local", RUN_LOCAL_PATH)
assert spec and spec.loader
run_local = importlib.util.module_from_spec(spec); spec.loader.exec_module(run_local)

class Auth:
    def repository_token(self, _repository: object) -> str: return "token"
class Reply:
    def __init__(self, value: object): self.value = value
    def read(self, _limit: int | None = None) -> bytes: return json.dumps(self.value).encode()
    def __enter__(self): return self
    def __exit__(self, *_: object) -> None: pass

class Impl019Tests(unittest.TestCase):
    sha = "a" * 40
    def test_http_server_routes_through_runtime(self) -> None:
        runtime = WorkerRuntime(FirestoreRuleStore(InMemoryFirestore()), type("V", (), {"verify": lambda *_: False})(), "a", JobHandlerRegistry())
        handler = handler_factory(runtime)
        def dispatch(method: str, path: str, headers: dict[str, str] | None = None) -> int:
            instance = handler.__new__(handler); instance.command, instance.path, instance.headers = method, path, headers or {}
            instance.rfile, instance.wfile = io.BytesIO(), io.BytesIO(); statuses: list[int] = []
            instance.send_response = lambda status: statuses.append(status); instance.send_header = lambda *_: None; instance.end_headers = lambda: None
            instance._dispatch(); return statuses[0]
        self.assertEqual(dispatch("POST", "/wrong"), 404); self.assertEqual(dispatch("GET", "/tasks/analysis-jobs"), 404)
        self.assertEqual(dispatch("POST", "/tasks/analysis-jobs"), 401); self.assertEqual(dispatch("POST", "/tasks/analysis-jobs", {"Authorization": "Bearer bad"}), 403)
    @patch("rulebranch.github_rest.urlopen")
    def test_github_rest_methods_and_tree_shapes(self, urlopen: Mock) -> None:
        urlopen.return_value = Reply({"tree": [{"path": "a", "sha": "s", "type": "blob"}], "truncated": False})
        repo = {"fullName": "o/r", "installationId": "42"}; self.assertEqual(RestGitDataApi(Auth()).tree(repo, self.sha), {"a": "s"}); self.assertEqual(RestGitTreeApi(Auth()).tree(repo, self.sha), ({"a": "s"}, False))
        request = urlopen.call_args.args[0]; self.assertEqual(request.get_method(), "GET"); self.assertIn(f"/repos/o/r/git/trees/{self.sha}?recursive=1", request.full_url); self.assertEqual(request.get_header("Authorization"), "Bearer token")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 30)
    @patch("rulebranch.github_rest.urlopen")
    def test_publication_rejects_incomplete_tree_before_overwriting_instructions(self, urlopen: Mock) -> None:
        urlopen.return_value = Reply({"tree": [{"path": "a", "sha": "s", "type": "blob"}], "truncated": True})
        repo = {"fullName": "o/r", "installationId": "42"}
        with self.assertRaisesRegex(ValueError, "Publication tree is truncated"):
            RestGitDataApi(Auth()).tree(repo, self.sha)
        self.assertEqual(RestGitTreeApi(Auth()).tree(repo, self.sha), ({"a": "s"}, True))
    @patch("rulebranch.github_rest.MAX_GITHUB_RESPONSE_BYTES", 8)
    @patch("rulebranch.github_rest.urlopen")
    def test_github_rest_rejects_oversized_response(self, urlopen: Mock) -> None:
        urlopen.return_value = Reply({"large": "response"})
        with self.assertRaisesRegex(ValueError, "response exceeds"):
            RestGitDataApi(Auth()).tree({"fullName": "o/r", "installationId": "42"}, self.sha)
    @patch("rulebranch.github_rest.urlopen")
    def test_contents_recurses_and_write_payloads(self, urlopen: Mock) -> None:
        urlopen.side_effect = [Reply([{"type": "dir", "path": "d"}, {"type": "file", "path": "a", "sha": "1"}]), Reply([{"type": "file", "path": "d/b", "sha": "2"}]), Reply({"sha": "blob"})]
        api = RestGitTreeApi(Auth()); self.assertEqual(api.contents_tree({"fullName":"o/r", "installationId":"i"}, self.sha), {"a":"1", "d/b":"2"}); self.assertEqual(api.blob({"fullName":"o/r", "installationId":"i"}, "hi"), "blob")
        request = urlopen.call_args.args[0]; self.assertEqual(request.get_method(), "POST"); self.assertEqual(json.loads(request.data), {"content":"hi", "encoding":"utf-8"})
    @patch("rulebranch.github_rest.urlopen")
    def test_ref_read_404_creates_missing_branch(self, urlopen: Mock) -> None:
        from urllib.error import HTTPError
        urlopen.side_effect = [HTTPError("https://api.github.com/x", 404, "missing", {}, None), Reply({})]
        RestGitDataApi(Auth()).ref({"fullName":"o/r", "installationId":"i"}, "new", "sha", True)
        self.assertEqual(urlopen.call_count, 2); self.assertEqual(urlopen.call_args_list[0].args[0].get_method(), "GET"); request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST"); self.assertEqual(json.loads(request.data), {"ref":"refs/heads/new", "sha":"sha"})
    @patch("rulebranch.github_rest.urlopen")
    def test_git_write_and_pull_request_endpoints(self, urlopen: Mock) -> None:
        urlopen.side_effect = [Reply({"object":{"sha":"head"}}), Reply({"tree":{"sha":"base-tree"}}), Reply({"sha":"tree"}), Reply({"sha":"commit"}), Reply({"number":7, "html_url":"https://pr"}), Reply({}), Reply({}), Reply([{"number":8, "html_url":"https://pr/8"}])]
        api, repo = RestGitDataApi(Auth()), {"fullName":"o/r", "installationId":"i"}
        self.assertEqual(api.branch_head(repo, "main"), "head"); self.assertEqual(api.new_tree(repo, self.sha, []), "tree"); self.assertEqual(api.commit(repo, "tree", "parent", "message"), "commit")
        self.assertEqual(api.open_pull_request(repo, "title", "body", "head", "main", True), {"number":7, "url":"https://pr"}); api.edit_pull_request(repo, 7, "edit"); api.close_pull_request(repo, 7)
        self.assertEqual(api.find_open_pull_request(repo, "rulebranch/rules-update", "main"), {"number":8, "url":"https://pr/8"})
        requests = [call.args[0] for call in urlopen.call_args_list]; self.assertIn("/git/ref/heads/main", requests[0].full_url)
        self.assertEqual(requests[1].get_method(), "GET"); self.assertTrue(requests[1].full_url.endswith(f"/git/commits/{self.sha}"))
        self.assertEqual(json.loads(requests[2].data), {"base_tree":"base-tree", "tree":[]}); self.assertEqual(json.loads(requests[3].data)["parents"], ["parent"]); self.assertEqual(json.loads(requests[5].data), {"body":"edit"}); self.assertEqual(json.loads(requests[6].data), {"state":"closed"})
        self.assertIn("state=open&head=o%3Arulebranch%2Frules-update&base=main", requests[7].full_url)
    def test_build_runtime_registers_production_handlers(self) -> None:
        env = {"GOOGLE_CLOUD_PROJECT":"p", "WORKER_URL":"https://worker", "WORKER_SERVICE_ACCOUNT_EMAIL":"worker@example.com", "GITHUB_APP_ID":"1", "GITHUB_APP_PRIVATE_KEY":"key", "RULEBRANCH_AI_PROVIDER":"gemini-api", "RULEBRANCH_AI_MODEL_FAST":"fast", "RULEBRANCH_AI_MODEL_REASONING":"reason"}
        runtime = build_runtime(env, lambda _project: InMemoryFirestore())
        for name in ("bootstrap", "compile", "publish_verify", "drift_scan", "proposal", "purge"): self.assertIsNotNone(runtime.handlers.get(name))
    def test_local_poll_once_finds_queued_jobs_across_workspaces(self) -> None:
        db = InMemoryFirestore()
        db.put("analysis_jobs", "one", {"id":"one", "ownerWorkspaceId":"workspace-a", "status":"queued"})
        db.put("analysis_jobs", "two", {"id":"two", "ownerWorkspaceId":"workspace-b", "status":"queued"})
        db.put("analysis_jobs", "done", {"id":"done", "ownerWorkspaceId":"workspace-a", "status":"done"})
        runtime = build_runtime({"GOOGLE_CLOUD_PROJECT":"p", "WORKER_URL":"https://worker", "WORKER_SERVICE_ACCOUNT_EMAIL":"worker@example.com", "GITHUB_APP_ID":"1", "GITHUB_APP_PRIVATE_KEY":"key", "RULEBRANCH_AI_PROVIDER":"gemini-api", "RULEBRANCH_AI_MODEL_FAST":"fast", "RULEBRANCH_AI_MODEL_REASONING":"reason"}, lambda _project: db)
        runtime.run_job = Mock()
        run_local.poll_once(runtime)
        self.assertCountEqual(runtime.run_job.call_args_list, [(("workspace-a", "one"),), (("workspace-b", "two"),)])

if __name__ == "__main__": unittest.main()


class InstructionBlobReadTests(unittest.TestCase):
    def test_rest_blob_read_decodes_exact_utf8_and_bounds_size(self):
        import base64
        from unittest.mock import patch
        class Auth:
            def repository_token(self, _repository): return "test-token"
        api = RestGitDataApi(Auth()); repo = {"fullName":"o/r", "installationId":"i"}
        text = "# 手書きの指示\r\n"
        with patch("rulebranch.github_rest._request", return_value={"encoding":"base64","content":base64.b64encode(text.encode()).decode()}):
            self.assertEqual(api.read_blob(repo,"a" * 40),text)
        with patch("rulebranch.github_rest._request", return_value={"encoding":"base64","content":base64.b64encode(b"x"*(1024*1024+1)).decode()}):
            with self.assertRaisesRegex(ValueError,"exceeds"): api.read_blob(repo,"a" * 40)
