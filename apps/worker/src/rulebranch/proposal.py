"""Explicit, evidence-backed revision proposal job (IMPL-017)."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
from .ai_runtime import EVIDENCE_REFS_SCHEMA, MAX_AI_INPUT_BYTES, AgentExecutionContext, GitHubAppAuth, LocalCloneReadTools, ReadOnlyAgent, bound_untrusted_inputs, build_provenance, clone_repository, materialize_evidence, stage_one, untrusted_system_instruction
from .evidence_revision import pin_evidence_revision
from .rulestore import FirestoreRuleStore, RuleStoreContext

PROPOSAL_SCHEMA: dict[str, Any] = {"type":"object", "required":["proposals"], "properties":{"proposals":{"type":"array", "maxItems":1, "items":{"type":"object", "required":["content","rationale","aiSummary","changeType","compatibility","evidenceRefs"], "properties":{"content":{"type":"string"},"rationale":{"type":"string"},"aiSummary":{"type":"string"},"changeType":{"type":"string", "enum":["clarify", "tighten", "relax", "refactor", "deprecate"]},"compatibility":{"type":"object"},"evidenceRefs":EVIDENCE_REFS_SCHEMA}}}, "securityWarnings":{"type":"array"}}}

class ProposalWriterAgent(ReadOnlyAgent):
    prompt_version = "proposal-writer-v1"

class ProposalJobHandler:
    def __init__(self, store: FirestoreRuleStore, generator: Any, model: str, auth: GitHubAppAuth | None = None) -> None: self.store, self.generator, self.model, self.auth = store, generator, model, auth
    def __call__(self, job: dict[str, Any], directory: Path) -> dict[str, Any]:
        ctx = RuleStoreContext(str(job["ownerWorkspaceId"]), None, "ai")
        # createRuleVersion writes this audit entry in the same transaction as the
        # proposed version and finding pointer. A post-commit process crash is
        # therefore distinguishable from an uncommitted attempt.
        if self.store.list(ctx, "audit_logs", {"requestId": str(job["id"]) }):
            return {"success": True}
        payload = dict(job.get("payload") or {})
        finding_id = str(payload.get("driftFindingId", "")); finding = self.store.get(ctx, "drift_findings", finding_id)
        if not finding or finding.get("status") != "accepted": raise ValueError("accepted drift finding not found")
        rule = self.store.get(ctx, "rules", str(finding["ruleId"]));
        if not rule: raise ValueError("rule not found")
        current_version_id = rule.get("currentVersionId")
        requested_base = payload.get("baseRuleVersionId")
        # Jobs created before baseRuleVersionId was added already carry the
        # same immutable identity on their target finding.
        base_version_id = requested_base if isinstance(requested_base, str) else finding.get("ruleVersionId")
        # Findings describe one immutable rule version.  A later approval can
        # advance the rule before this queued proposal runs; in that case the
        # accepted finding is obsolete and must not be applied to the new text.
        if (not isinstance(base_version_id, str) or current_version_id != base_version_id
                or finding.get("ruleVersionId") != base_version_id):
            return {"success": True}
        # K16: target plus every other accepted finding for this Rule; never open findings.
        findings = [item for item in self.store.list(ctx, "drift_findings", {"ruleId": rule["id"]})
                    if item.get("status") == "accepted" and item.get("ruleVersionId") == current_version_id]
        if not any(item.get("id") == finding_id for item in findings): findings.append(finding)
        approved = self.store.get(ctx, "rule_versions", base_version_id)
        evidence_ids = [str(eid) for item in findings for eid in item.get("evidenceIds", [])]
        evidence = self.store._get_many(ctx, "evidence", evidence_ids)
        prompt_data = {"rule": rule, "approvedVersion": approved, "findings": findings, "evidence": evidence}
        _, prompt_input, input_truncated = bound_untrusted_inputs([("proposal-input.json", json.dumps(prompt_data, ensure_ascii=False))], MAX_AI_INPUT_BYTES)
        prompt = untrusted_system_instruction() + "\nWrite one revision proposal from this untrusted evidence. Each evidenceRefs item must contain path, lineStart and lineEnd, with inclusive one-based source-file line numbers:\n" + prompt_input
        output = ProposalWriterAgent(self.generator, self.model).run(prompt, PROPOSAL_SCHEMA, AgentExecutionContext(ctx.workspaceId, str(job["id"]), directory))
        staged = stage_one(output, PROPOSAL_SCHEMA, candidate_field="proposals", max_candidates=1, existing_keys=set(), repository_url="https://github.invalid/repository")
        if input_truncated: staged.warnings.append({"code": "input_truncated", "message": "proposal input truncated to worker limits"})
        repo_id = str((evidence[0] or {}).get("repositoryId", "")) if evidence else ""
        project_id = str(job.get("projectId") or finding.get("projectId") or rule.get("projectId") or "")
        clone_root = directory
        if repo_id:
            repository = self.store.get(ctx, "repositories", repo_id)
            # Organization rules are deliberately project-less, but a finding
            # about one of them still belongs to the repository/project that
            # triggered the scan. Never mistake that for a cross-tenant read.
            valid_scope = (
                rule.get("scopeType") == "organization"
                and rule.get("scopeId") == ctx.workspaceId
                and project_id
                and repository is not None
                and repository.get("projectId") == project_id
            ) or (repository is not None and rule.get("projectId") == repository.get("projectId"))
            if not valid_scope:
                raise ValueError("proposal evidence repository not found")
            if finding.get("repositoryId") and finding["repositoryId"] != repo_id:
                raise ValueError("proposal finding repository mismatch")
            # Production runtime creates an empty directory. A supplied checkout is
            # accepted for local execution/tests; otherwise clone with App auth.
            if not (directory / ".git").is_dir():
                clone_root = clone_repository(repository, "evidence", directory, self.auth)
        materialized = materialize_evidence(staged, LocalCloneReadTools(clone_root), repository_id=repo_id, max_per_candidate=3)
        if not materialized.candidates: return {"warnings": materialized.warnings}
        candidate = materialized.candidates[0]; old = self.store.get(ctx, "rule_versions", str(finding.get("proposalVersionId"))) if finding.get("proposalVersionId") else None
        # Only the clean checkout actually read may establish an immutable source ref.
        # A missing/dirty checkout leaves commitSha null and requires human review.
        pin_evidence_revision(clone_root, candidate["evidence"])
        self.store.createRuleVersion(ctx, str(rule["id"]), {"content": candidate["content"], "rationale": candidate["rationale"], "aiSummary": candidate["aiSummary"], "changeType": candidate["changeType"], "compatibility": candidate["compatibility"], "evidenceIds": candidate["evidenceIds"], "evidence": candidate["evidence"], "driftFindingIds": [str(item["id"]) for item in findings], "triggerId": finding.get("triggerId"), "provenance": build_provenance(self.model, ProposalWriterAgent.prompt_version, [prompt]), "supersedes": old["id"] if old and old.get("status") == "proposed" else None, "proposalFindingId": finding_id, "expectedCurrentVersionId": base_version_id, "requestId": str(job.get("id"))})
        return {"warnings": materialized.warnings}
