import subprocess
import tempfile
import unittest
from pathlib import Path
from rulebranch.evidence_revision import pin_evidence_revision


class EvidenceRevisionTest(unittest.TestCase):
    def test_clean_checkout_uses_actual_head_not_model_supplied_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            (root / "example.txt").write_text("evidence", encoding="utf-8")
            subprocess.run(["git", "-C", directory, "add", "."], check=True)
            subprocess.run(["git", "-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            actual = subprocess.check_output(["git", "-C", directory, "rev-parse", "HEAD"], text=True).strip()
            evidence = [{"ref": {"commitSha": "invented"}}]
            self.assertTrue(pin_evidence_revision(root, evidence))
            self.assertEqual(evidence[0]["ref"]["commitSha"], actual)
            (root / "example.txt").write_text("changed", encoding="utf-8")
            self.assertFalse(pin_evidence_revision(root, evidence))
            self.assertIsNone(evidence[0]["ref"]["commitSha"])

    def test_no_checkout_clears_untrusted_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = [{"ref": {"commitSha": "a" * 40}}]
            self.assertFalse(pin_evidence_revision(Path(directory), evidence))
            self.assertIsNone(evidence[0]["ref"]["commitSha"])
