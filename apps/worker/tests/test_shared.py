from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from rulebranch.config import load_config
from rulebranch.contracts import ENUMS, LIMITS
from rulebranch.errors import ERROR_CODES
from rulebranch.ulid import generate_ulid

ROOT = Path(__file__).resolve().parents[3]

class SharedFoundationTests(unittest.TestCase):
    def test_enum_contract_parity(self) -> None:
        expected = {key: tuple(value) for key, value in json.loads((ROOT / "contracts/enums.json").read_text()).items()}
        self.assertEqual(ENUMS, expected)

    def test_limits_contract_parity(self) -> None:
        self.assertEqual(LIMITS, json.loads((ROOT / "contracts/limits.json").read_text()))

    def test_config_rejects_non_cloud_saas(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"RULEBRANCH_DEPLOYMENT_MODE": "customer-cloud"})
        config = load_config({"RULEBRANCH_AI_PROVIDER": "vertex-ai", "RULEBRANCH_AI_MODEL_FAST": "from-env-fast", "RULEBRANCH_AI_MODEL_REASONING": "from-env-reasoning"})
        self.assertEqual(config.ai_model_fast, "from-env-fast")

    def test_ulid(self) -> None:
        self.assertEqual(len(generate_ulid(1)), 26)
        self.assertLess(generate_ulid(1), generate_ulid(2))
        self.assertNotEqual(generate_ulid(5), generate_ulid(5))

    def test_error_catalog(self) -> None:
        self.assertEqual(len(ERROR_CODES), 16)

if __name__ == "__main__":
    unittest.main()
