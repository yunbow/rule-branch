"""Regression coverage for initial publication and actionable GitHub failures."""
import io
import json
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from rulebranch.github_rest import GitHubApiError, RestGitDataApi, RestGitTreeApi

class Auth:
    def repository_token(self, _repository):
        return "private-token"

class Reply:
    def __init__(self, value):
        self.value = value
    def read(self, _limit=None):
        return json.dumps(self.value).encode()
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        pass

def failure(code, message):
    return HTTPError("https://api.github.com/repos/o/r/git/refs", code, "failure",
                     {"X-GitHub-Request-Id": "qa-request"}, io.BytesIO(json.dumps({"message": message, "errors": [{"input": "private-data"}]}).encode()))

class GitHubReferenceRecoveryTests(unittest.TestCase):
    repo = {"fullName": "o/r", "installationId": "i"}

    @patch("rulebranch.github_rest.urlopen")
    def test_missing_publication_branch_is_created_without_patching_nonexistent_ref(self, urlopen):
        urlopen.side_effect = [failure(404, "Not Found"), Reply({})]
        RestGitDataApi(Auth()).ref(self.repo, "rulebranch/rules-update", "sha", True)
        requests = [call.args[0] for call in urlopen.call_args_list]
        self.assertEqual([request.get_method() for request in requests], ["GET", "POST"])
        self.assertTrue(requests[0].full_url.endswith("/git/ref/heads/rulebranch/rules-update"))
        self.assertEqual(json.loads(requests[1].data), {"ref": "refs/heads/rulebranch/rules-update", "sha": "sha"})

    @patch("rulebranch.github_rest.urlopen")
    def test_existing_branch_preserves_requested_fast_forward_policy(self, urlopen):
        urlopen.side_effect = [Reply({"object": {"sha": "old"}}), Reply({})]
        RestGitDataApi(Auth()).ref(self.repo, "branch", "new", False)
        requests = [call.args[0] for call in urlopen.call_args_list]
        self.assertEqual([request.get_method() for request in requests], ["GET", "PATCH"])
        self.assertEqual(json.loads(requests[1].data), {"sha": "new", "force": False})

    @patch("rulebranch.github_rest.urlopen")
    def test_create_race_confirms_branch_and_updates_without_forcing(self, urlopen):
        urlopen.side_effect = [failure(404, "Not Found"), failure(422, "Reference already exists"), Reply({"object": {"sha": "old"}}), Reply({})]
        RestGitDataApi(Auth()).ref(self.repo, "branch", "new", False)
        self.assertEqual([call.args[0].get_method() for call in urlopen.call_args_list], ["GET", "POST", "GET", "PATCH"])
        self.assertFalse(json.loads(urlopen.call_args.args[0].data)["force"])

    @patch("rulebranch.github_rest.urlopen")
    def test_permissions_and_validation_errors_are_never_reinterpreted_as_missing_branch(self, urlopen):
        for code in [403, 409, 422]:
            with self.subTest(code=code):
                urlopen.reset_mock()
                urlopen.side_effect = [failure(code, "Validation failed")]
                with self.assertRaises(HTTPError) as caught:
                    RestGitDataApi(Auth()).ref(self.repo, "branch", "new", True)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(urlopen.call_count, 1)
        urlopen.reset_mock()
        urlopen.side_effect = [failure(404, "Not Found"), failure(422, "Invalid SHA")]
        with self.assertRaisesRegex(GitHubApiError, "Invalid SHA"):
            RestGitDataApi(Auth()).ref(self.repo, "branch", "new", True)
        self.assertEqual(urlopen.call_count, 2)

    @patch("rulebranch.github_rest.urlopen")
    def test_failure_contains_method_endpoint_message_and_request_id_without_credentials(self, urlopen):
        urlopen.side_effect = [failure(422, "Reference does not exist private-token\n")]
        with self.assertRaises(HTTPError) as caught:
            RestGitDataApi(Auth()).ref(self.repo, "branch", "new", True)
        message = str(caught.exception)
        for expected in ["422", "GET /repos/o/r/git/ref/heads/branch", "Reference does not exist", "qa-request"]:
            self.assertIn(expected, message)
        for forbidden in ["private-token", "private-data", "Bearer", "\n"]:
            self.assertNotIn(forbidden, message)

    @patch("rulebranch.github_rest.urlopen")
    def test_unstructured_failure_keeps_status_and_does_not_dump_body(self, urlopen):
        urlopen.side_effect = [HTTPError("https://api.github.com/x", 502, "Bad Gateway", {}, io.BytesIO(b"<html>private-data</html>"))]
        with self.assertRaises(HTTPError) as caught:
            RestGitDataApi(Auth()).ref(self.repo, "branch", "new", True)
        self.assertEqual(caught.exception.code, 502)
        self.assertIn("Bad Gateway", str(caught.exception))
        self.assertNotIn("private-data", str(caught.exception))

    @patch("rulebranch.github_rest.urlopen")
    def test_url_components_cannot_change_the_github_api_endpoint(self, urlopen):
        api = RestGitDataApi(Auth())
        for repository in [{"fullName": "../.."}, {"fullName": "owner/.."}, {"fullName": "owner/repo?x=y"}]:
            with self.subTest(repository=repository), self.assertRaisesRegex(ValueError, "repository name"):
                api.branch_head(repository, "main")
        for branch in ["main?per_page=100", "../admin", "refs//heads"]:
            with self.subTest(branch=branch), self.assertRaisesRegex(ValueError, "ref name"):
                api.branch_head(self.repo, branch)
        self.assertEqual(urlopen.call_count, 0)

    @patch("rulebranch.github_rest.urlopen")
    def test_valid_ref_with_slash_plus_and_unicode_is_percent_encoded(self, urlopen):
        urlopen.return_value = Reply({"object": {"sha": "head"}})
        self.assertEqual(RestGitDataApi(Auth()).branch_head(self.repo, "feature/日本+1"), "head")
        url = urlopen.call_args.args[0].full_url
        self.assertIn("/feature/", url); self.assertIn("%2B1", url); self.assertNotIn("日本", url)

    @patch("rulebranch.github_rest.urlopen")
    def test_git_object_ids_and_recursive_content_paths_are_safe(self, urlopen):
        api = RestGitTreeApi(Auth())
        for object_id in [".", "..", "a" * 39, "g" * 40, "a" * 40 + "?x=1"]:
            with self.subTest(object_id=object_id), self.assertRaisesRegex(ValueError, "object ID"):
                api.tree(self.repo, object_id)
        self.assertEqual(urlopen.call_count, 0)
        urlopen.side_effect = [Reply([{"type": "dir", "path": "docs/a?#"}]), Reply([])]
        self.assertEqual(api.contents_tree(self.repo, "a" * 40), {})
        nested_url = urlopen.call_args_list[1].args[0].full_url
        self.assertIn("/contents/docs/a%3F%23?ref=", nested_url)
