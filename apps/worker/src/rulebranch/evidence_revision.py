"""Bind materialized evidence to the checkout actually read, not an AI-supplied ref."""
from __future__ import annotations
import re
import subprocess
from pathlib import Path
from typing import Any


def pin_evidence_revision(root: Path, evidence: list[dict[str, Any]]) -> bool:
    try:
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True, timeout=10)
        commit = result.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("invalid commit")
        # Dirty worktrees do not represent the immutable HEAD evidence snapshot.
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], check=True, capture_output=True, text=True, timeout=10)
        if dirty.stdout.strip():
            raise ValueError("dirty checkout")
    except (OSError, subprocess.SubprocessError, ValueError):
        commit = None
    for item in evidence:
        ref = item.get("ref")
        if isinstance(ref, dict):
            ref["commitSha"] = commit
    return commit is not None
