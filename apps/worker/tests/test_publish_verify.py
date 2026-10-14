from __future__ import annotations
import unittest
from rulebranch.publish_verify import PublishVerifyJobHandler
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext
from tests.fake_firestore import InMemoryFirestore

class FakeTrees:
    def __init__(self, values, truncated=False): self.values, self.truncated, self.fallback, self.head_sha = values, truncated, False, "abc"
    def branch_head(self, _repo, _branch): return self.head_sha
    def tree(self, _repo, _sha): return self.values, self.truncated
    def contents_tree(self, _repo, _sha): self.fallback = True; return self.values

class PublishVerifyTests(unittest.TestCase):
    def seed(self, actual="expected", rule_id="rule"):
        db, ctx = InMemoryFirestore(), RuleStoreContext("w", None, "system")
        for coll, id, data in [
            ("repositories", "repo", {"id":"repo","ownerWorkspaceId":"w","projectId":"p","status":"active"}),
            ("revision_prs", "pr", {"id":"pr","ownerWorkspaceId":"w","projectId":"p","repositoryId":"repo","resolutionSnapshotId":"snap","status":"merged","prNumber":1,"prUrl":"url"}),
            ("rules", "rule", {"id":"rule","ownerWorkspaceId":"w","status":"active","staleSince":None}),
            ("compiled_artifacts", "art", {"id":"art","ownerWorkspaceId":"w","revisionPrId":"pr","resolutionSnapshotId":"snap","path":".rulebranch/rules/L1/r.md","gitBlobSha":"expected","ruleId":rule_id,"commitSha":None,"publishedAt":None}),
        ]: db.put(coll,id,data)
        return db, ctx, FakeTrees({".rulebranch/rules/L1/r.md": actual})
    def test_verified_persists_publication_and_fallback(self):
        db, ctx, api = self.seed(); api.truncated=True
        PublishVerifyJobHandler(FirestoreRuleStore(db), api)({"ownerWorkspaceId":"w","payload":{"revisionPrId":"pr","repositoryId":"repo","commitSha":"abc","reason":"push"}}, None)
        self.assertTrue(api.fallback); self.assertEqual(db.snapshot("revision_prs","pr").to_dict()["verification"]["state"], "verified"); self.assertEqual(db.snapshot("compiled_artifacts","art").to_dict()["commitSha"], "abc")
    def test_mismatch_creates_one_finding_and_stales_rule(self):
        db, ctx, api = self.seed("changed")
        handler = PublishVerifyJobHandler(FirestoreRuleStore(db), api); job={"ownerWorkspaceId":"w","payload":{"revisionPrId":"pr","repositoryId":"repo","commitSha":"abc"}}
        handler(job,None); handler(job,None)
        findings=[x.to_dict() for x in db.query("drift_findings",[])]; self.assertEqual(len(findings),1); self.assertEqual(len(db.query("change_triggers",[])),1); self.assertEqual(findings[0]["confidence"],1.0); self.assertEqual(db.snapshot("rules","rule").to_dict()["status"],"stale")
    def test_two_repositories_get_separate_findings_and_one_fix_does_not_clear_other(self):
        db, ctx, api = self.seed("changed")
        db.put("repositories", "other", {"id": "other", "ownerWorkspaceId": "w", "projectId": "p", "status": "active"})
        db.put("revision_prs", "other-pr", {"id": "other-pr", "ownerWorkspaceId": "w", "projectId": "p",
                "repositoryId": "other", "resolutionSnapshotId": "other-snap", "status": "merged", "prNumber": 2})
        db.put("compiled_artifacts", "other-art", {"id": "other-art", "ownerWorkspaceId": "w",
                "revisionPrId": "other-pr", "resolutionSnapshotId": "other-snap",
                "path": ".rulebranch/rules/L1/r.md", "gitBlobSha": "expected", "ruleId": "rule"})
        handler = PublishVerifyJobHandler(FirestoreRuleStore(db), api)
        job = lambda repo, revision, sha: {"ownerWorkspaceId":"w", "payload":{
            "revisionPrId":revision,"repositoryId":repo,"commitSha":sha}}
        handler(job("repo","pr","abc"), None)
        handler(job("other","other-pr","abc"), None)
        findings = [f.to_dict() for f in db.query("drift_findings",[])]
        self.assertEqual(len(findings),2)
        self.assertEqual({f["repositoryId"] for f in findings},{"repo","other"})
        api.values = {".rulebranch/rules/L1/r.md":"expected"}
        api.head_sha = "fixed"
        handler(job("repo","pr","fixed"), None)
        findings = [f.to_dict() for f in db.query("drift_findings",[])]
        self.assertEqual({f["repositoryId"] for f in findings if f["status"] == "open"},{"other"})
        self.assertEqual(db.snapshot("rules","rule").to_dict()["status"],"stale")

    def test_aggregate_file_is_recorded_without_finding(self):
        db, ctx, api = self.seed("changed", None)
        PublishVerifyJobHandler(FirestoreRuleStore(db), api)({"ownerWorkspaceId":"w","payload":{"revisionPrId":"pr","repositoryId":"repo","commitSha":"abc"}},None)
        self.assertEqual(len(db.query("drift_findings",[])),0); self.assertEqual(len(db.query("change_triggers",[])),1)

    def test_deleted_file_reappears_after_merge_and_is_not_verified(self):
        db, ctx, api = self.seed()
        path = ".rulebranch/rules/L3/deleted.md"
        pr = db.snapshot("revision_prs", "pr").to_dict()
        db.put("revision_prs", "pr", {**pr, "expectedDeletedPaths": [path]})
        api.values[path] = "unexpected manual content"
        handler = PublishVerifyJobHandler(FirestoreRuleStore(db), api)
        job = {"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "abc"}}
        handler(job, None)
        failed = db.snapshot("revision_prs", "pr").to_dict()["verification"]
        self.assertEqual(failed["state"], "mismatch")
        self.assertIn(path, failed["mismatchedPaths"])
        api.values.pop(path)
        api.head_sha = "fixed"
        handler(job, None)
        self.assertEqual(db.snapshot("revision_prs", "pr").to_dict()["verification"]["state"], "verified")
        api.values[path] = "reintroduced"
        api.head_sha = "readded"
        handler(job, None)
        self.assertEqual(db.snapshot("revision_prs", "pr").to_dict()["verification"]["state"], "mismatch")

    def test_deletion_only_revision_never_verifies_resurrected_path(self):
        db, ctx, api = self.seed()
        path = ".rulebranch/rules/L3/obsolete.md"
        pr = db.snapshot("revision_prs", "pr").to_dict()
        db.put("revision_prs", "pr", {**pr, "expectedDeletedPaths": [path]})
        art = db.snapshot("compiled_artifacts", "art").to_dict()
        db.put("compiled_artifacts", "art", {**art, "resolutionSnapshotId": "older"})
        api.values = {path: "unexpected"}
        PublishVerifyJobHandler(FirestoreRuleStore(db), api)(
            {"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "abc"}}, None)
        verification = db.snapshot("revision_prs", "pr").to_dict()["verification"]
        self.assertEqual(verification["state"], "mismatch")
        self.assertEqual(verification["mismatchedPaths"], [path])
        self.assertEqual(len(db.query("drift_findings", [])), 0)

    def test_obsolete_pr_cannot_report_new_generation_as_tampering(self):
        db, ctx, api = self.seed("new-blob")
        db.put("revision_prs", "new", {"id": "new", "ownerWorkspaceId": "w", "repositoryId": "repo", "projectId": "p", "status": "merged", "prNumber": 3, "mergedAt": "2026-10-11"})
        PublishVerifyJobHandler(FirestoreRuleStore(db), api)({"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "new-commit"}}, None)
        self.assertEqual(len(db.query("drift_findings", [])), 0)
        self.assertEqual(db.snapshot("rules", "rule").to_dict()["status"], "active")
        self.assertNotIn("verification", db.snapshot("revision_prs", "pr").to_dict())

    def test_merge_during_tree_fetch_cannot_persist_obsolete_result(self):
        db, ctx, api = self.seed("changed")
        newer = {"id": "new", "ownerWorkspaceId": "w", "repositoryId": "repo", "status": "draft_open", "prNumber": 3}
        db.put("revision_prs", "new", newer)
        def tree(_repo, _sha):
            db.put("revision_prs", "new", {**newer, "status": "merged", "mergedAt": "2026-10-11"})
            return api.values, False
        api.tree = tree
        PublishVerifyJobHandler(FirestoreRuleStore(db), api)({"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "abc"}}, None)
        self.assertEqual(len(db.query("drift_findings", [])), 0)
        self.assertNotIn("verification", db.snapshot("revision_prs", "pr").to_dict())

    def test_verified_artifacts_resolve_mismatch_but_preserve_other_drift(self):
        for other_drift in [False, True]:
            db, ctx, api = self.seed("changed")
            handler = PublishVerifyJobHandler(FirestoreRuleStore(db), api)
            job = {"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "abc"}}
            handler(job, None)
            if other_drift:
                db.put("drift_findings", "other", {"id": "other", "ownerWorkspaceId": "w", "ruleId": "rule", "status": "open", "driftType": "dependency_update"})
            api.values = {".rulebranch/rules/L1/r.md": "expected"}
            api.head_sha = "fixed"
            handler({**job, "payload": {**job["payload"], "commitSha": "fixed"}}, None)
            findings = [item.to_dict() for item in db.query("drift_findings", [])]
            self.assertEqual(next(item for item in findings if item["driftType"] == "artifact_mismatch")["status"], "resolved")
            self.assertEqual(db.snapshot("rules", "rule").to_dict()["status"], "stale" if other_drift else "active")

    def test_stale_clean_job_cannot_clear_newer_mismatch(self):
        db, ctx, api = self.seed("changed")
        api.head_sha = "newer"
        path = ".rulebranch/rules/L1/r.md"
        seen = []
        def tree(_repo, sha):
            seen.append(sha)
            return ({path: "expected" if sha == "older" else "changed"}, False)
        api.tree = tree
        handler = PublishVerifyJobHandler(FirestoreRuleStore(db), api)
        newer = {"ownerWorkspaceId": "w", "payload": {"revisionPrId": "pr", "repositoryId": "repo", "commitSha": "newer"}}
        handler(newer, None)
        handler({**newer, "payload": {**newer["payload"], "commitSha": "older"}}, None)
        self.assertEqual(seen, ["newer"])
        self.assertEqual(db.snapshot("revision_prs", "pr").to_dict()["verification"]["state"], "mismatch")
        self.assertEqual(db.snapshot("rules", "rule").to_dict()["status"], "stale")


if __name__ == "__main__": unittest.main()
