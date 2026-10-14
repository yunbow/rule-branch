from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Any

def log(severity: str, message: str, **fields: Any) -> None:
    """Emit one Cloud Logging-compatible JSON object to stdout."""
    payload = {"severity": severity, "message": message, "timestamp": datetime.now(UTC).isoformat(), "serviceContext": {"service": "rulebranch-worker"}, **fields}
    print(json.dumps(payload, default=str), file=sys.stdout, flush=True)
