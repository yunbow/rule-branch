import unittest
from rulebranch.compiler import AUTO_HEADER, HEADER, compile, git_blob_sha


class ApprovalCompilerTest(unittest.TestCase):
    def test_delegated_approval_header_and_hashes_are_deterministic(self):
        rule = {"id": "r", "key": "style", "layer": "L3", "enforcement": "advisory"}
        version = {"id": "v", "ruleId": "r", "content": "Use PascalCase.", "approvalReview": {"state": "auto_approved"}}
        value = {"resolutionSnapshot": {"ruleVersionIds": ["v"]}, "rules": [rule], "ruleVersions": [version], "repository": {"compileTargets": ["agents-md", "rulebranch-rules"]}}
        first = compile(value)
        self.assertEqual(first, compile(value))
        self.assertEqual(len(first), 2)
        for artifact in first:
            self.assertTrue(AUTO_HEADER in artifact.content)
            self.assertEqual(artifact.gitBlobSha, git_blob_sha(artifact.content))
        version.pop("approvalReview")
        for artifact in compile(value):
            self.assertTrue(HEADER in artifact.content)

