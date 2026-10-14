"""Bootstrap RuleExtractor job: collect, validate, materialize, then persist."""
from __future__ import annotations

from copy import deepcopy
import logging
from pathlib import Path
import shutil
import subprocess
import time
from typing import Any, Mapping, Sequence

from .ai_runtime import (AgentExecutionContext, GitHubAppAuth, LocalCloneReadTools, ReadOnlyAgent,
    MAX_AI_INPUT_BYTES, StructuredGenerator, bound_untrusted_inputs, build_provenance, materialize_evidence, scan_prompt_injection,
    clone_repository, repository_clone_url, stage_one, untrusted_system_instruction)
from .evidence_revision import pin_evidence_revision
from .contracts import LIMITS
from .rulestore import FirestoreRuleStore, RuleStoreContext

LOGGER = logging.getLogger(__name__)
PROMPT_VERSION = "rule-extractor-v1"
MANIFESTS = {"package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "Gemfile", "composer.json"}
INSTRUCTIONS = {"agents.md", "claude.md", ".github/copilot-instructions.md"}
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift"}
# Cloud Run gives the Worker request 600s. Repository collection is kept to at
# most 360s so model generation, evidence verification, and persistence retain a
# meaningful completion window instead of being killed by the platform timeout.
MAX_REPOSITORIES_PER_BOOTSTRAP = 4
MAX_REPOSITORY_COLLECTION_SECONDS = 360
MAX_CHECKOUT_BYTES = 512 * 1024 * 1024
MAX_REPOSITORY_INPUT_BYTES = 512 * 1024
MAX_SELECTED_FILES = 80
MAX_TREE_PROMPT_ENTRIES = 500

RULE_EXTRACTOR_SCHEMA: dict[str, Any] = {
    "type": "object", "required": ["candidates"], "properties": {
        "candidates": {"type": "array", "items": {"type": "object", "required": ["key", "title", "layer", "type", "evaluationMode", "enforcement", "selector", "content", "rationale", "compatibility", "confidence", "evidenceRefs"], "properties": {
            "key": {"type": "string"}, "title": {"type": "string"}, "layer": {"type": "string", "enum": ["L1", "L2", "L3"]}, "type": {"type": "string", "enum": ["policy", "guideline", "workflow", "architecture", "security", "coding-style", "interaction"]}, "evaluationMode": {"type": "string", "enum": ["deterministic", "semantic", "hybrid"]}, "enforcement": {"type": "string", "enum": ["locked", "default", "advisory"]}, "selector": {"type": "object"}, "content": {"type": "string"}, "rationale": {"type": "string"}, "compatibility": {"type": "object"}, "confidence": {"type": "number"}, "evidenceRefs": {"type": "array", "items": {"type": "object", "required": ["path", "lineStart", "lineEnd"], "properties": {"path": {"type": "string"}, "lineStart": {"type": "integer"}, "lineEnd": {"type": "integer"}, "repositoryId": {"type": "string"}}}}
        }}}, "securityWarnings": {"type": "array"}
    }
}


class RuleExtractorAgent(ReadOnlyAgent):
    """Read-only AgentBase adapter for the bootstrap structured response."""
    prompt_version = PROMPT_VERSION


def collect_repository_input(root: Path) -> tuple[list[tuple[str, str]], str]:
    """Bound collection so raw repository text only reaches the model as data."""
    tools, selected = LocalCloneReadTools(root), []
    tree = tools.list_tree()
    for path in tree:
        lower, suffix = path.lower(), Path(path).suffix.lower()
        if Path(path).name in MANIFESTS or Path(path).name.lower().startswith("readme") or lower in INSTRUCTIONS or suffix in SOURCE_SUFFIXES:
            selected.append(path)
    # Keep source sampling finite and deterministic; instruction/readme/manifest files win.
    def priority(path: str) -> tuple[int, str]:
        lower, name = path.lower(), Path(path).name
        return (0 if lower in INSTRUCTIONS else 1 if name in MANIFESTS or name.lower().startswith("readme") else 2, path)
    selected = sorted(selected, key=priority)[:MAX_SELECTED_FILES]
    contents: list[tuple[str, str]] = [("FILE_TREE", "\n".join(tree[:MAX_TREE_PROMPT_ENTRIES]))]
    for path in selected:
        try: candidate = (path, "".join(tools.read_file(".", path).splitlines(keepends=True)[:160]))
        except (OSError, ValueError): continue
        # Bound incrementally. A repository with 80 eligible 256-KiB files must
        # not retain ~20 MiB merely to discard it at the end of collection.
        bounded, _, truncated = bound_untrusted_inputs(contents + [candidate], MAX_REPOSITORY_INPUT_BYTES)
        contents = bounded
        if truncated: break
    bounded, prompt, _ = bound_untrusted_inputs(contents, MAX_REPOSITORY_INPUT_BYTES)
    return bounded, prompt


def _checkout_exceeds_limit(root: Path, limit: int = MAX_CHECKOUT_BYTES, deadline: float | None = None) -> bool:
    """Return as soon as allocated checkout entries exceed the per-repo cap."""
    total = 0
    for path in root.rglob("*"):
        if deadline is not None and time.monotonic() >= deadline: return True
        try:
            if path.is_file() and not path.is_symlink(): total += path.stat().st_size
        except OSError:
            continue
        if total > limit: return True
    return False


def _replace_checkout_with_evidence_files(root: Path, inputs: Sequence[tuple[str, str]]) -> None:
    """Keep only bounded files the model actually received, then drop .git."""
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=False)
    resolved_root = root.resolve()
    for path, content in inputs:
        if path == "FILE_TREE": continue
        target = (resolved_root / path).resolve()
        if target == resolved_root or resolved_root not in target.parents:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


class BootstrapJobHandler:
    def __init__(self, store: FirestoreRuleStore, generator: StructuredGenerator, model: str, injection_patterns: Sequence[str], auth: GitHubAppAuth | None = None) -> None:
        self.store, self.generator, self.model, self.injection_patterns, self.auth = store, generator, model, tuple(injection_patterns), auth

    def __call__(self, job: dict[str, Any], directory: Path) -> dict[str, Any]:
        workspace_id, job_id = str(job["ownerWorkspaceId"]), str(job["id"])
        project_id = str((job.get("payload") or {}).get("projectId") or job.get("projectId") or "")
        ctx = RuleStoreContext(workspace_id, None, "ai")
        project = self.store.get(ctx, "projects", project_id)
        if not project: raise ValueError("project not found")
        repositories = sorted(
            (r for r in self.store.list(ctx, "repositories", {"projectId": project_id})
             if r.get("status") != "removed"),
            key=lambda repository: str(repository.get("id", "")),
        )
        all_inputs: list[tuple[str, str]] = []; repository_urls: list[str] = []; cloned_repository_ids: list[str] = []
        input_truncated = len(repositories) > MAX_REPOSITORIES_PER_BOOTSTRAP
        collection_deadline = time.monotonic() + MAX_REPOSITORY_COLLECTION_SECONDS
        repository_commits: dict[str, str | None] = {}
        for repository in repositories[:MAX_REPOSITORIES_PER_BOOTSTRAP]:
            repository_id = str(repository["id"]); url = repository_clone_url(repository)
            remaining = collection_deadline - time.monotonic()
            if remaining <= 1:
                input_truncated = True
                break
            # The repository id is the stable prefix exposed to evidenceRefs.
            try:
                clone = clone_repository(repository, repository_id, directory, self.auth, timeout_seconds=remaining)
                if _checkout_exceeds_limit(clone, deadline=collection_deadline):
                    input_truncated = True
                    shutil.rmtree(clone, ignore_errors=True)
                    if time.monotonic() >= collection_deadline: break
                    continue
                revision = {"ref": {}}
                pin_evidence_revision(clone, [revision])
                repository_commits[repository_id] = revision["ref"].get("commitSha")
                inputs, _ = collect_repository_input(clone)
                if time.monotonic() >= collection_deadline:
                    input_truncated = True
                    shutil.rmtree(clone, ignore_errors=True)
                    break
                combined = all_inputs + [(f"{repository_id}/{path}", text) for path, text in inputs]
                all_inputs, _, truncated = bound_untrusted_inputs(combined, MAX_AI_INPUT_BYTES)
                input_truncated = input_truncated or truncated
                retained = [(path.removeprefix(f"{repository_id}/"), text) for path, text in all_inputs
                            if path.startswith(f"{repository_id}/")]
                _replace_checkout_with_evidence_files(clone, retained)
                cloned_repository_ids.append(repository_id); repository_urls.append(url)
                if truncated: break
            except subprocess.TimeoutExpired:
                # The total deadline is authoritative; a slow repository must not
                # make the platform kill the whole request after 600 seconds.
                input_truncated = True
                shutil.rmtree(directory / repository_id, ignore_errors=True)
                if time.monotonic() >= collection_deadline: break
        warnings = scan_prompt_injection(all_inputs, self.injection_patterns)
        if input_truncated: warnings.append({"code": "input_truncated", "message": "repository input truncated to worker limits"})
        if not repository_urls: return {"warnings": warnings + [{"code": "evidence_unverifiable", "message": "no cloneable repositories"}]}
        _, prompt_inputs, _ = bound_untrusted_inputs(all_inputs, MAX_AI_INPUT_BYTES)
        prompt = (f"{untrusted_system_instruction()}\nProject hints: primaryLanguages={project.get('primaryLanguages', [])}; frameworks={project.get('frameworks', [])}; focusThemes={project.get('focusThemes', [])}. "
                  "Use these only as selector defaults. Extract project-scoped rule candidates with verifiable evidenceRefs. Use 1-based inclusive source line numbers; select the actual declaration, dependency/version entry, or behavior supporting each claim, never punctuation-only lines.\n" + prompt_inputs)
        output = RuleExtractorAgent(self.generator, self.model).run(prompt, RULE_EXTRACTOR_SCHEMA, AgentExecutionContext(workspace_id, job_id, directory))
        raw = deepcopy(output)
        candidates = raw.get("candidates", [])
        if isinstance(candidates, list):
            candidates.sort(key=lambda item: float(item.get("confidence", 0)) if isinstance(item, Mapping) else 0, reverse=True)
            for candidate in candidates:
                if isinstance(candidate, dict) and candidate.get("enforcement") == "locked":
                    # K10: this is Cloud Logging only, never an output_truncated warning.
                    LOGGER.info("bootstrap_locked_enforcement_coerced", extra={"projectId": project_id, "key": candidate.get("key")})
                    candidate["enforcement"] = "default"
        raw["candidates"] = candidates
        existing = {str(rule.get("key")) for rule in self.store.list(ctx, "rules", {"projectId": project_id})}
        first = stage_one(raw, RULE_EXTRACTOR_SCHEMA, candidate_field="candidates", max_candidates=int(LIMITS["limits"]["maxBootstrapRules"]), existing_keys=existing, repository_url=repository_urls[0])
        materialized = []
        for candidate in first.candidates:
            refs = candidate.get("evidenceRefs", [])
            repo_id = str(refs[0].get("repositoryId")) if refs and isinstance(refs[0], dict) and refs[0].get("repositoryId") else cloned_repository_ids[0]
            if repo_id not in cloned_repository_ids:
                warnings.append({"code": "evidence_unverifiable", "message": "candidate references an uncollected repository"})
                continue
            normalized_refs = []
            for ref in candidate.pop("evidenceRefs", []):
                if not isinstance(ref, dict):
                    normalized_refs.append(ref); continue
                normalized = dict(ref); normalized.pop("commitSha", None)
                path = str(normalized.get("path", "")); prefix = f"{repo_id}/"
                if path.startswith(prefix): normalized["path"] = path[len(prefix):]
                normalized_refs.append(normalized)
            candidate["evidence"] = normalized_refs
            # Scope verification to the selected repository mirror. A model cannot
            # label evidence from repository B as belonging to repository A.
            one = materialize_evidence(type(first)([candidate], []), LocalCloneReadTools(directory / repo_id), repository_id=repo_id, commit_sha=repository_commits.get(repo_id), max_per_candidate=int(LIMITS["limits"]["maxEvidencePerBootstrapRule"]))
            materialized.extend(one.candidates); warnings.extend(one.warnings)
        for candidate in materialized:
            candidate["scopeType"] = "project"
            candidate["provenance"] = build_provenance(self.model, PROMPT_VERSION, [text for _, text in all_inputs])
        self.store.createBootstrapBatch(ctx, project_id, materialized)
        return {"warnings": warnings + first.warnings}
