"""Cloud Run HTTP entrypoint for RuleBranch analysis jobs."""
from __future__ import annotations
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping, Type

from .ai_runtime import GeminiStructuredGenerator, GitHubAppAuth
from .config import load_config
from .github_publisher import GitHubPublisher
from .github_rest import RestGitDataApi, RestGitTreeApi, RestInstallationTokenApi
from .job_runtime import MAX_TASK_BODY_BYTES, GoogleOidcVerifier, HttpResponse, JobHandlerRegistry, WorkerRuntime
from .rulestore import FirestoreRuleStore

def build_runtime(env: Mapping[str, str], firestore_factory: Callable[[str], Any] | None = None) -> WorkerRuntime:
    if firestore_factory is None:
        from google.cloud import firestore
        firestore_factory = lambda project: firestore.Client(project=project)
    config = load_config(env)
    store = FirestoreRuleStore(firestore_factory(env["GOOGLE_CLOUD_PROJECT"]))
    generator = GeminiStructuredGenerator(config.ai_provider, project=env.get("GOOGLE_CLOUD_PROJECT"), location=env.get("GOOGLE_CLOUD_LOCATION"))
    auth = GitHubAppAuth(env["GITHUB_APP_ID"], env["GITHUB_APP_PRIVATE_KEY"], RestInstallationTokenApi(), store=store)
    handlers = JobHandlerRegistry(); handlers.register_bootstrap(store, generator, config.ai_model_reasoning, config.ai_injection_patterns, auth)
    handlers.register_compile(store, GitHubPublisher(RestGitDataApi(auth), auth)); handlers.register_publish_verify(store, RestGitTreeApi(auth))
    handlers.register_drift_scan(store, generator, config.ai_model_fast, auth); handlers.register_proposal(store, generator, config.ai_model_reasoning, auth)
    return WorkerRuntime(store, GoogleOidcVerifier(env["WORKER_SERVICE_ACCOUNT_EMAIL"]), env["WORKER_URL"], handlers, hard_deadline=True)

def _content_length(value: str | None) -> int:
    try: length = int(value or "0")
    except ValueError as error: raise ValueError("invalid Content-Length") from error
    if length < 0: raise ValueError("invalid Content-Length")
    if length > MAX_TASK_BODY_BYTES: raise OverflowError("request body is too large")
    return length

def handler_factory(runtime: WorkerRuntime) -> Type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None: self._dispatch()
        def do_GET(self) -> None: self._dispatch()
        def _dispatch(self) -> None:
            try: length = _content_length(self.headers.get("Content-Length")); response = runtime.handle_http(self.command, self.path, dict(self.headers.items()), self.rfile.read(length))
            except ValueError: response = HttpResponse(400, {"error": "INVALID_TASK"}); self.close_connection = True
            except OverflowError: response = HttpResponse(413, {"error": "PAYLOAD_TOO_LARGE"}); self.close_connection = True
            body = json.dumps(response.body).encode() if response.body else b""
            self.send_response(response.status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            if body: self.wfile.write(body)
        def log_message(self, _format: str, *_args: object) -> None: pass
    return Handler

def main() -> None:
    runtime = build_runtime(os.environ); server = ThreadingHTTPServer(("", int(os.environ.get("PORT", "8080"))), handler_factory(runtime))
    server.serve_forever()
if __name__ == "__main__": main()
