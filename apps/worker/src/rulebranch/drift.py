"""Dependency drift scan handler.  Git/AI ports are injected so tests never contact GitHub/Gemini."""
from __future__ import annotations
from pathlib import Path
from typing import Any
import json, subprocess
from .ai_runtime import (EVIDENCE_REFS_SCHEMA, MAX_AI_INPUT_BYTES, AgentExecutionContext, GitHubAppAuth, LocalCloneReadTools, ReadOnlyAgent, bound_untrusted_inputs, build_provenance,
                         clone_repository, fetch_git_commit, materialize_evidence, stage_one, untrusted_system_instruction)
from .contracts import LIMITS
from .rulestore import FirestoreRuleStore, RuleStoreContext, _repository_matches

SCHEMA = {"type":"object", "required":["findings"], "properties":{"findings":{"type":"array", "items":{"type":"object", "required":["ruleId","driftType","severity","confidence","summary","detail","evidenceRefs"], "properties":{"ruleId":{"type":"string"},"driftType":{"type":"string","enum":["dependency_drift","compatibility_drift"]},"severity":{"type":"string","enum":["info","low","medium","high"]},"confidence":{"type":"number"},"summary":{"type":"string"},"detail":{"type":"string"},"evidenceRefs":EVIDENCE_REFS_SCHEMA}}}}}
def _deps(text: str) -> dict[str,str]:
    try:
        value=json.loads(text); return {str(k):str(v) for group in ("dependencies","devDependencies","peerDependencies") for k,v in (value.get(group,{}) or {}).items()}
    except Exception: return {}
class DriftDetectorAgent(ReadOnlyAgent): pass
class DriftScanJobHandler:
    def __init__(self, store: FirestoreRuleStore, generator: Any, model: str, auth: GitHubAppAuth | None = None) -> None: self.store,self.generator,self.model,self.auth=store,generator,model,auth
    def __call__(self, job: dict[str,Any], directory: Path) -> dict[str,Any]:
        ctx=RuleStoreContext(str(job["ownerWorkspaceId"]),None,"ai"); trigger=self.store.get(ctx,"change_triggers",str(job["payload"]["triggerId"]));
        if not trigger: raise ValueError("trigger not found")
        # The finding/evidence/trigger write is atomic. If Cloud Run committed it
        # and died before marking the job done, a stale-lease retry must not ask the
        # model again or create another set of findings.
        if trigger.get("processedAt") is not None: return {"success": True}
        source=trigger.get("source",{}); repo_id=str(source.get("repositoryId","")); raw_paths=source.get("paths",[])
        raw_paths = raw_paths if isinstance(raw_paths, list) else []
        maximum_paths = int(LIMITS["limits"]["maxFilesPerPrAnalysis"])
        paths = raw_paths[:maximum_paths]; input_truncated = len(raw_paths) > maximum_paths
        clone_root=directory
        if repo_id:
            repository=self.store.get(ctx,"repositories",repo_id)
            if not repository or repository.get("status") != "active" or repository.get("projectId") != trigger.get("projectId"):
                raise ValueError("active trigger repository not found")
            token=self.auth.repository_token(repository) if self.auth is not None else None
            # Older callers/tests may supply a checkout. Production runtime only
            # creates the empty job directory, so materialize the exact webhook
            # revision here before reading any repository data.
            if not (directory/".git").is_dir(): clone_root=clone_repository(repository,"repository",directory,token=token)
            after_sha=source.get("commitSha")
            if isinstance(after_sha,str) and after_sha:
                fetch_git_commit(clone_root,after_sha,repository,token=token)
                subprocess.run(["git","checkout","--detach",after_sha],cwd=clone_root,check=True,capture_output=True,text=True)
            if trigger.get("type") == "manual_review" and not source.get("commitSha"):
                sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=clone_root, check=True, capture_output=True, text=True).stdout.strip()
                def pin_source(tx):
                    ref = self.store._ref("change_triggers", str(trigger["id"]))
                    current = tx.get(ref).to_dict()
                    if not current or current.get("ownerWorkspaceId") != ctx.workspaceId:
                        raise ValueError("trigger not found")
                    pinned = current.get("source", {})
                    if pinned.get("commitSha"):
                        return pinned
                    pinned = {**source, "commitSha": sha}
                    tx.update(ref, {"source": pinned})
                    return pinned
                source = self.store.runTransaction(pin_source)
                if source["commitSha"] != sha:
                    fetch_git_commit(clone_root, source["commitSha"], repository, token=token)
                    subprocess.run(["git", "checkout", "--detach", source["commitSha"]], cwd=clone_root, check=True, capture_output=True, text=True)
            before_sha=source.get("before")
            if isinstance(before_sha,str) and before_sha: fetch_git_commit(clone_root,before_sha,repository,token=token)
        # Reuse the clone-root guard for current content. A repository can contain
        # symlinks, and Path.read_text() would otherwise follow one outside the
        # checkout and send it to the model.
        tools=LocalCloneReadTools(clone_root)
        if trigger.get("type") == "manual_review":
            if not repo_id: raise ValueError("manual scan repository required")
            tree = tools.list_tree()
            raw_paths = [path for path in tree if Path(path).name == "package.json"
                         and not any(part in {"node_modules", ".git", ".next", "vendor"} for part in Path(path).parts)]
            paths = raw_paths[:maximum_paths]
            input_truncated = len(raw_paths) > maximum_paths or len(tree) >= tools.max_tree_entries
        changes=[]; change_bytes=2; changes_full=False
        manifest_inputs = []
        for path in paths:
            if not isinstance(path,str): continue
            try: after=tools.read_file(".",path)
            except (OSError,ValueError,PermissionError): continue
            manifest_inputs.append((path, after))
            before=""
            if source.get("before"):
                p=subprocess.run(["git","show",f"{source['before']}:{path}"],cwd=clone_root,capture_output=True,text=True)
                if p.returncode==0: before=p.stdout
            before_dependencies, after_dependencies = _deps(before), _deps(after)
            for name in sorted(set(before_dependencies) | set(after_dependencies)):
                if before_dependencies.get(name) != after_dependencies.get(name):
                    change = {"name":name,"from":before_dependencies.get(name),"to":after_dependencies.get(name)}
                    size = len(json.dumps(change).encode("utf-8")) + 1
                    if change_bytes + size > MAX_AI_INPUT_BYTES:
                        input_truncated = True; changes_full = True; break
                    changes.append(change); change_bytes += size
            if changes_full: break
        rules=[r for r in self.store.list(ctx,"rules") if r.get("status") in {"active","stale"}
               and (r.get("projectId")==trigger.get("projectId") or r.get("scopeType")=="organization")
               and _repository_matches(r, repo_id)]
        names = {change["name"] for change in changes}
        ranked = [rule for rule in rules if names & (
            set((rule.get("selector") or {}).get("dependencies", []))
            | set((rule.get("maintenance") or {}).get("watchDependencies", [])))]
        candidates = ranked + [rule for rule in rules if rule not in ranked]
        approved_rules = []
        for rule in candidates[:100]:
            version = self.store.get(ctx, "rule_versions", str(rule.get("currentVersionId", ""))) if rule.get("currentVersionId") else None
            if not version or version.get("status") != "approved" or version.get("ruleId") != rule["id"]:
                continue
            entry = {"ruleId": rule["id"], "ruleVersionId": version["id"], "key": rule.get("key"),
                     "selector": rule.get("selector"), "maintenance": rule.get("maintenance"),
                     "enforcement": rule.get("enforcement"), "content": version.get("content"),
                     "rationale": version.get("rationale")}
            # Never advertise a rule whose complete approved text did not fit.
            _, _, truncated = bound_untrusted_inputs([
                ("approved-rules.json", json.dumps(approved_rules + [entry], ensure_ascii=False))], MAX_AI_INPUT_BYTES // 2)
            if truncated:
                input_truncated = True
                continue
            approved_rules.append(entry)
        input_truncated = input_truncated or len(candidates) > 100
        _, rules_input, _ = bound_untrusted_inputs([
            ("approved-rules.json", json.dumps(approved_rules, ensure_ascii=False))], MAX_AI_INPUT_BYTES // 2)
        _, changes_input, prompt_truncated = bound_untrusted_inputs([
            ("dependency-diff.json", json.dumps(changes))], MAX_AI_INPUT_BYTES // 4)
        retained_manifests, manifest_input, manifest_truncated = bound_untrusted_inputs(manifest_inputs, MAX_AI_INPUT_BYTES // 4)
        prompt = (untrusted_system_instruction()
                  + "\nCompare the approved rule text and selectors with the dependency changes and current manifests. "
                  "Report only demonstrable contradictions for supplied ruleIds. "
                  "Evidence refs must use supplied manifest paths and actual one-based line numbers. Each evidenceRefs item must contain path, lineStart and lineEnd; use inclusive source-file line numbers, not JSON object keys. "
                  "An absent rule or empty change set is not evidence of drift.\n"
                  + ("Manual review: compare current dependency declarations with the approved rules; "
                     "from=null means no comparison baseline, not an upgrade.\n" if trigger.get("type") == "manual_review" else "")
                  + rules_input + "\n" + changes_input + "\n" + manifest_input)
        output=DriftDetectorAgent(self.generator,self.model).run(prompt,SCHEMA,AgentExecutionContext(ctx.workspaceId,str(job["id"]),clone_root))
        staged=stage_one(output,SCHEMA,candidate_field="findings",max_candidates=100,existing_keys=set(),repository_url="https://github.invalid/repository")
        allowed_rules = {entry["ruleId"]: entry["ruleVersionId"] for entry in approved_rules}
        allowed_paths = {path for path, _ in retained_manifests}
        staged.candidates = [finding for finding in staged.candidates if finding.get("ruleId") in allowed_rules
                             and all(isinstance(ref, dict) and ref.get("path") in allowed_paths
                                     for ref in finding.get("evidenceRefs", []))]
        if input_truncated or prompt_truncated or manifest_truncated: staged.warnings.append({"code":"input_truncated","message":"dependency input truncated to worker limits"})
        for finding in staged.candidates:
            # Only the references checked against the supplied manifests may be
            # materialized. Ignore an untrusted alternate `evidence` property.
            finding.pop("evidence", None)
            for ref in finding.get("evidenceRefs", []):
                ref.pop("commitSha", None)
        materialized=materialize_evidence(staged,tools,repository_id=repo_id,commit_sha=source.get("commitSha"),max_per_candidate=3)
        for finding in materialized.candidates:
            finding["ruleVersionId"] = allowed_rules[finding["ruleId"]]
            finding["provenance"] = build_provenance(self.model, "drift-detector-v2", [prompt])
        self.store.createDriftScanBatch(ctx,str(trigger["id"]),materialized.candidates)
        return {"warnings":materialized.warnings}

