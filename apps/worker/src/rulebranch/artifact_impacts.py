"""Map aggregate instruction artifacts to the versions actually published.

Aggregate files affect every non-personal version in their pinned snapshot.
This is conservative attribution, not semantic attribution of edited lines.
"""
from __future__ import annotations
from typing import Any
from .managed_instructions import INSTRUCTION_PATHS


def artifact_impacts(store: Any, ctx: Any, publication: dict[str, Any],
                     artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    aggregates = any(not item.get("ruleId") and item.get("path") in INSTRUCTION_PATHS for item in artifacts)
    versions: dict[str, str] = {}
    if aggregates:
        snapshot = store.get(ctx, "resolution_snapshots", str(publication.get("resolutionSnapshotId", "")))
        if (not snapshot or snapshot.get("repositoryId") != publication.get("repositoryId")
                or snapshot.get("projectId") != publication.get("projectId")):
            raise ValueError("Publication impact snapshot missing or mismatched")
        ids = list(dict.fromkeys(str(value) for value in snapshot.get("ruleVersionIds", [])))
        documents = store._get_many(ctx, "rule_versions", ids)
        if {str(item["id"]) for item in documents} != set(ids):
            raise ValueError("Publication impact version missing")
        rule_ids = list(dict.fromkeys(str(version.get("ruleId", "")) for version in documents))
        if any(not rule_id for rule_id in rule_ids):
            raise ValueError("Publication impact rule missing")
        rules = store._get_many(ctx, "rules", rule_ids)
        rules_by_id = {str(rule["id"]): rule for rule in rules}
        if set(rules_by_id) != set(rule_ids):
            raise ValueError("Publication impact rule missing")
        for version in documents:
            rule_id = version.get("ruleId")
            if not isinstance(rule_id, str) or not rule_id:
                raise ValueError("Publication impact rule missing")
            rule = rules_by_id[rule_id]
            project_id = rule.get("projectId")
            if project_id is not None and project_id != publication.get("projectId"):
                raise ValueError("Publication impact rule project mismatch")
            if rule.get("enforcement") == "personal":
                continue
            versions[rule_id] = str(version["id"])

    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for artifact in artifacts:
        links = ({str(artifact["ruleId"]): artifact.get("ruleVersionId")}
                 if artifact.get("ruleId") else versions if artifact.get("path") in INSTRUCTION_PATHS else {})
        for rule_id, version_id in links.items():
            key = (str(artifact["path"]), rule_id)
            if key not in seen:
                result.append({**artifact, "ruleId": rule_id, "ruleVersionId": version_id})
                seen.add(key)
    return result
