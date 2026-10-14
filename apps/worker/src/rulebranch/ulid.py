from __future__ import annotations

import secrets
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def _encode(value: int, length: int) -> str:
    result = ""
    for _ in range(length):
        result = _ALPHABET[value & 31] + result
        value >>= 5
    return result

def generate_ulid(timestamp_ms: int | None = None) -> str:
    timestamp = time.time_ns() // 1_000_000 if timestamp_ms is None else timestamp_ms
    if timestamp < 0:
        raise ValueError("ULID timestamp must be non-negative")
    return _encode(timestamp, 10) + _encode(secrets.randbits(80), 16)
