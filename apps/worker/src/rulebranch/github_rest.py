"""Small standard-library GitHub REST adapters used only by Worker job handlers."""
from __future__ import annotations

import base64
import json
import re
from io import BytesIO
from typing import Any, Mapping
from urllib.parse import quote, urlencode, urlsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .ai_runtime import GitHubAppAuth
from .execution_guard import checkpoint

API = "https://api.github.com"
GITHUB_REQUEST_TIMEOUT_SECONDS = 30
MAX_GITHUB_RESPONSE_BYTES = 10 * 1024 * 1024
_REPOSITORY_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_GIT_OBJECT_RE = re.compile(r"[0-9a-fA-F]{40}")


def _repository_name(repository: Mapping[str, object]) -> str:
    full_name = repository.get("fullName")
    if (not isinstance(full_name, str) or not _REPOSITORY_RE.fullmatch(full_name)
            or any(component in {".", ".."} for component in full_name.split("/"))):
        raise ValueError("invalid GitHub repository name")
    return full_name


def _git_object(value: object) -> str:
    text = str(value)
    if not _GIT_OBJECT_RE.fullmatch(text):
        raise ValueError("invalid Git object ID")
    return text


def _ref_name(value: object) -> str:
    text = str(value)
    components = text.split("/")
    forbidden = set(" ~^:?*[\\")
    if (not text or len(text.encode("utf-8")) > 1024 or text.startswith("/") or text.endswith(("/", ".", ".lock"))
            or "//" in text or ".." in text or "@{" in text
            or any(not component or component.startswith(".") or component.endswith(".lock") for component in components)
            or any(ord(character) < 32 or ord(character) == 127 or character in forbidden for character in text)):
        raise ValueError("invalid Git ref name")
    return text


def _content_path(value: object) -> str:
    text = str(value)
    components = text.split("/") if text else []
    if text.startswith("/") or any(component in {"", ".", ".."} for component in components):
        raise ValueError("invalid repository content path")
    return quote(text, safe="/")

class GitHubApiError(HTTPError):
    """HTTPError-compatible failure with bounded, credential-free API context."""
    def __init__(self, error: HTTPError, method: str, url: str, message: str, request_id: str) -> None:
        self.github_message = message
        detail = f"{method} {urlsplit(url).path}: {message}"
        if request_id:
            detail += f" (request {request_id})"
        super().__init__(error.url, error.code, detail, error.headers, BytesIO())


def _request(method: str, url: str, token: str, body: Mapping[str, Any] | None = None) -> Any:
    checkpoint()
    data = json.dumps(body).encode() if body is not None else None
    request = Request(url, data=data, method=method, headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", **({"Content-Type": "application/json"} if data else {})})
    try:
        with urlopen(request, timeout=GITHUB_REQUEST_TIMEOUT_SECONDS) as response:  # nosec B310 -- URLs are fixed GitHub API paths
            raw = response.read(MAX_GITHUB_RESPONSE_BYTES + 1)
    except HTTPError as error:
        # Never include request headers, bodies, or GitHub's error inputs in job errors.
        message = str(error.reason)
        try:
            payload = json.loads(error.read(8192).decode("utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("message"), str):
                message = payload["message"]
        except (ValueError, UnicodeError, AttributeError, TypeError, OSError):
            pass
        finally:
            error.close()
        message = " ".join(message.replace(token, "[redacted]").split())[:300] if token else " ".join(message.split())[:300]
        request_id = " ".join(str((error.headers or {}).get("X-GitHub-Request-Id", "")).split())[:100]
        raise GitHubApiError(error, method, url, message, request_id) from None
    if len(raw) > MAX_GITHUB_RESPONSE_BYTES:
        raise ValueError("GitHub response exceeds worker limit")
    return json.loads(raw.decode() or "{}")

class RestInstallationTokenApi:
    def create_installation_access_token(self, installation_id: str, app_jwt: str) -> Mapping[str, str]:
        if not installation_id.isdecimal():
            raise ValueError("invalid GitHub installation ID")
        return _request("POST", f"{API}/app/installations/{installation_id}/access_tokens", app_jwt)  # type: ignore[return-value]

class _RestGitBase:
    def __init__(self, auth: GitHubAppAuth) -> None: self._auth = auth
    def _repo_token(self, repository: Mapping[str, object]) -> tuple[str, str]:
        return _repository_name(repository), self._auth.repository_token(repository)
    def _recursive_tree(self, repository: Mapping[str, object], commit_sha: str) -> tuple[dict[str, str], bool]:
        full_name, token = self._repo_token(repository)
        payload = _request("GET", f"{API}/repos/{full_name}/git/trees/{_git_object(commit_sha)}?recursive=1", token)
        return ({str(item["path"]): str(item["sha"]) for item in payload.get("tree", []) if item.get("type") == "blob"}, bool(payload.get("truncated", False)))
    def branch_head(self, repository: Mapping[str, object], branch: str) -> str:
        full_name, token = self._repo_token(repository); branch = quote(_ref_name(branch), safe="/")
        return str(_request("GET", f"{API}/repos/{full_name}/git/ref/heads/{branch}", token)["object"]["sha"])
    def blob(self, repository: Mapping[str, object], content: str) -> str:
        full_name, token = self._repo_token(repository); return str(_request("POST", f"{API}/repos/{full_name}/git/blobs", token, {"content": content, "encoding": "utf-8"})["sha"])
    def new_tree(self, repository: Mapping[str, object], base_commit: str, entries: list[dict[str, object]]) -> str:
        full_name, token = self._repo_token(repository)
        commit = _request("GET", f"{API}/repos/{full_name}/git/commits/{_git_object(base_commit)}", token)
        return str(_request("POST", f"{API}/repos/{full_name}/git/trees", token,
                            {"base_tree": commit["tree"]["sha"], "tree": entries})["sha"])
    def commit(self, repository: Mapping[str, object], tree_sha: str, parent_sha: str, message: str) -> str:
        full_name, token = self._repo_token(repository); return str(_request("POST", f"{API}/repos/{full_name}/git/commits", token, {"message": message, "tree": tree_sha, "parents": [parent_sha]})["sha"])
    def ref(self, repository: Mapping[str, object], branch: str, sha: str, force: bool) -> None:
        full_name, token = self._repo_token(repository)
        branch = _ref_name(branch); encoded_branch = quote(branch, safe="/")
        read_url = f"{API}/repos/{full_name}/git/ref/heads/{encoded_branch}"
        update_url = f"{API}/repos/{full_name}/git/refs/heads/{encoded_branch}"
        try:
            _request("GET", read_url, token)
        except HTTPError as error:
            if error.code != 404:
                raise
            try:
                _request("POST", f"{API}/repos/{full_name}/git/refs", token,
                         {"ref": f"refs/heads/{branch}", "sha": sha})
                return
            except GitHubApiError as create_error:
                # Another request may create the branch after our GET. Only this
                # specific conflict can be recovered; other 422s remain failures.
                if create_error.code != 422 or create_error.github_message != "Reference already exists":
                    raise
                _request("GET", read_url, token)
        _request("PATCH", update_url, token, {"sha": sha, "force": force})
    def open_pull_request(self, repository: Mapping[str, object], title: str, body: str, head: str, base: str, draft: bool) -> dict[str, object]:
        full_name, token = self._repo_token(repository); value = _request("POST", f"{API}/repos/{full_name}/pulls", token, {"title": title, "body": body, "head": head, "base": base, "draft": draft}); return {"number": value["number"], "url": value["html_url"]}
    def edit_pull_request(self, repository: Mapping[str, object], number: int, body: str) -> None:
        if number <= 0: raise ValueError("invalid pull request number")
        full_name, token = self._repo_token(repository); _request("PATCH", f"{API}/repos/{full_name}/pulls/{number}", token, {"body": body})
    def close_pull_request(self, repository: Mapping[str, object], number: int) -> None:
        if number <= 0: raise ValueError("invalid pull request number")
        full_name, token = self._repo_token(repository); _request("PATCH", f"{API}/repos/{full_name}/pulls/{number}", token, {"state": "closed"})
    def find_open_pull_request(self, repository: Mapping[str, object], head: str, base: str) -> dict[str, object] | None:
        full_name, token = self._repo_token(repository); owner = full_name.split("/", 1)[0]
        head, base = _ref_name(head), _ref_name(base)
        query = urlencode({"state": "open", "head": f"{owner}:{head}", "base": base, "per_page": "1"})
        values = _request("GET", f"{API}/repos/{full_name}/pulls?{query}", token)
        if not isinstance(values, list) or not values: return None
        return {"number": values[0]["number"], "url": values[0]["html_url"]}

class RestGitDataApi(_RestGitBase):
    def read_blob(self, repository: Mapping[str, object], sha: str) -> str:
        full_name, token = self._repo_token(repository)
        payload = _request("GET", f"{API}/repos/{full_name}/git/blobs/{_git_object(sha)}", token)
        if payload.get("encoding") != "base64": raise ValueError("Unsupported Git blob encoding")
        content = base64.b64decode("".join(str(payload["content"]).split()), validate=True)
        if len(content) > 1024 * 1024: raise ValueError("Instruction file exceeds 1 MiB publication limit")
        return content.decode("utf-8")
    def tree(self, repository: Mapping[str, object], commit_sha: str) -> dict[str, str]:
        tree, truncated = self._recursive_tree(repository, commit_sha)
        if truncated: raise ValueError("Publication tree is truncated; refuse to overwrite unread instructions")
        return tree

class RestGitTreeApi(_RestGitBase):
    def tree(self, repository: Mapping[str, object], commit_sha: str) -> tuple[dict[str, str], bool]: return self._recursive_tree(repository, commit_sha)
    def contents_tree(self, repository: Mapping[str, object], commit_sha: str) -> dict[str, str]:
        full_name, token = self._repo_token(repository); found: dict[str, str] = {}; commit_sha = _git_object(commit_sha)
        def visit(path: str) -> None:
            encoded_path = _content_path(path) if path else ""
            payload = _request("GET", f"{API}/repos/{full_name}/contents/{encoded_path}?ref={commit_sha}", token)
            entries = payload if isinstance(payload, list) else [payload]
            for entry in entries:
                if entry.get("type") == "file": found[str(entry["path"])] = str(entry["sha"])
                elif entry.get("type") == "dir": visit(str(entry["path"]))
        visit(""); return found

