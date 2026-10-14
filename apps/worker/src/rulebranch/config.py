from __future__ import annotations

import os
import json
from dataclasses import dataclass
from typing import Mapping

from .contracts import LIMITS

@dataclass(frozen=True)
class AppConfig:
    deployment_mode: str
    ai_provider: str
    ai_model_fast: str
    ai_model_reasoning: str
    ai_injection_patterns: tuple[str, ...]
    limits: dict[str, object]

def load_config(env: Mapping[str, str] | None = None) -> AppConfig:
    values = os.environ if env is None else env
    mode = values.get("RULEBRANCH_DEPLOYMENT_MODE", "cloud-saas")
    if mode != "cloud-saas":
        raise ValueError(f"Unsupported deployment.mode: {mode}")
    provider = values.get("RULEBRANCH_AI_PROVIDER")
    if provider not in {"gemini-api", "vertex-ai"}:
        raise ValueError("ai.provider must be gemini-api or vertex-ai")
    fast, reasoning = values.get("RULEBRANCH_AI_MODEL_FAST"), values.get("RULEBRANCH_AI_MODEL_REASONING")
    if not fast or not reasoning:
        raise ValueError("ai.model.fast and ai.model.reasoning must be configured")
    defaults = (
        r"ignore\s+(?:all\s+)?previous\s+instructions?",
        r"system\s+prompt",
        r"you\s+are\s+now",
        r"(?:以前|前)の指示(?:を)?(?:無視|上書き)",
        r"システム(?:プロンプト|指示)",
    )
    raw_patterns = values.get("RULEBRANCH_AI_INJECTION_PATTERNS")
    try:
        patterns = tuple(json.loads(raw_patterns)) if raw_patterns else defaults
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("ai.injectionPatterns must be a JSON string array") from error
    if not all(isinstance(pattern, str) for pattern in patterns):
        raise ValueError("ai.injectionPatterns must be a JSON string array")
    return AppConfig(mode, provider, fast, reasoning, patterns, LIMITS)
