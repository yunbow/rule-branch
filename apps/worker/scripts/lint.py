"""Dependency-free syntax lint for the Phase 0 worker."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for directory in (ROOT / "src", ROOT / "tests"):
    for path in directory.rglob("*.py"):
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError as exc:
            print(exc, file=sys.stderr)
            raise SystemExit(1) from exc
