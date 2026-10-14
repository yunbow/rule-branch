"""Shared JSON contracts and DM 2.5 governance types."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, TypeAlias, TypedDict

_ROOT = Path(__file__).resolve().parents[4]

def _load_contract(name: str) -> Any:
    with (_ROOT / "contracts" / name).open(encoding="utf-8") as handle:
        return json.load(handle)

ENUMS: dict[str, tuple[str, ...]] = {key: tuple(values) for key, values in _load_contract("enums.json").items()}
LIMITS: dict[str, Any] = _load_contract("limits.json")
ScopeType: TypeAlias = Literal["organization", "team", "project", "user"]
Visibility: TypeAlias = Literal["private", "team", "organization", "public"]
Enforcement: TypeAlias = Literal["locked", "default", "advisory", "personal"]
RetentionClass: TypeAlias = Literal["standard", "personal-data", "evidence", "audit"]

class Provenance(TypedDict):
    sourceType: str
    sourceRef: str
    derivedFromCustomerCode: bool

class GovernanceFields(TypedDict):
    ownerWorkspaceId: str
    scopeType: ScopeType
    scopeId: str
    visibility: Visibility
    enforcement: Enforcement | None
    transferPolicy: str
    licenseType: str
    provenance: Provenance
    containsPersonalData: bool
    containsConfidentialData: bool
    retentionClass: RetentionClass
    createdAt: str
    updatedAt: str
    deletedAt: str | None
    createdBy: dict[str, str]
