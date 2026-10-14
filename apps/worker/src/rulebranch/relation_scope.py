"""Conservative scope proof before removing a parent policy.

Each nonempty selector dimension is a constraint. Repository selection is
already handled by the resolver and is not a contextual (file/language) scope.
We deliberately do not attempt general glob-language containment.
"""
from __future__ import annotations

from fnmatch import fnmatchcase
from typing import Any, Mapping

CONTEXT_FIELDS = ("languages", "frameworks", "directoryGlobs", "dependencies")


def _values(selector: Mapping[str, Any], field: str) -> set[str]:
    values = selector.get(field, [])
    if values is None:
        return set()
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError(f"Invalid relation selector: {field}")
    if field in {"languages", "frameworks"}:
        return {value.casefold() for value in values}
    return set(values)


def uncovered_relation_fields(
    parent_selector: Mapping[str, Any] | None,
    child_selector: Mapping[str, Any] | None,
    requested_selector: Mapping[str, Any] | None = None,
) -> list[str]:
    """Return dimensions where removing the parent would broaden the exception.

    For a repository-wide snapshot (no request constraints), the child must be
    unconstrained or provably cover the parent's entire scope in every dimension.
    Equal glob strings are a proof; arbitrary overlapping globs are not.

    A scoped resolver may additionally use a request wholly inside the child's
    scope. Concrete file paths use one-way fnmatch, never the symmetric overlap
    test used to gather candidates. A partially specified request is not proof.
    The compiler must omit requested_selector: its output files are repo-wide.
    """
    parent, child, requested = parent_selector or {}, child_selector or {}, requested_selector or {}
    if not all(isinstance(value, Mapping) for value in (parent, child, requested)):
        raise ValueError("Invalid relation selector")
    uncovered = []
    for field in CONTEXT_FIELDS:
        child_values = _values(child, field)
        if not child_values:
            continue
        parent_values = _values(parent, field)
        if parent_values and parent_values <= child_values:
            continue
        requested_values = _values(requested, field)
        if requested_values:
            if field != "directoryGlobs" and requested_values <= child_values:
                continue
            if field == "directoryGlobs" and all(
                value in child_values or (
                    not any(character in value for character in "*?[")
                    and any(fnmatchcase(value, pattern) for pattern in child_values)
                )
                for value in requested_values
            ):
                continue
        uncovered.append(field)
    return uncovered
