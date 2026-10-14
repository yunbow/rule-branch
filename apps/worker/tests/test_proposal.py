from __future__ import annotations
import sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src")); sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_firestore import InMemoryFirestore
from rulebranch.ai_runtime import FixedStructuredGenerator
from rulebranch.job_runtime import JobHandlerRegistry, WorkerRuntime
from rulebranch.proposal import ProposalJobHandler
from rulebranch.rulestore import FirestoreRuleStore, RuleStoreContext

class ProposalTests(unittest.TestCase):
 def setUp(self):
  self.db=InMemoryFirestore(); self.store=FirestoreRuleStore(self.db); self.ctx=RuleStoreContext("w",None,"ai"); self.db.put("projects","p",{"id":"p","ownerWorkspaceId":"w","status":"active","deletedAt":None})
  self.db.put("rules","r",{"id":"r","ownerWorkspaceId":"w","projectId":"p","scopeType":"project","scopeId":"p","visibility":"private","enforcement":"default","transferPolicy":"project-only","licenseType":"proprietary-customer","status":"stale","currentVersionId":"current","nextVersion":2})
  self.db.put("rule_versions","current",{"id":"current","ownerWorkspaceId":"w","ruleId":"r","version":1,"status":"approved","content":"Use x v1","rationale":"approved"})
  for ident,status in (("f","accepted"),("other","accepted"),("open","open")):
   self.db.put("drift_findings",ident,{"id":ident,"ownerWorkspaceId":"w","ruleId":"r","ruleVersionId":"current","projectId":"p","triggerId":"t","status":status,"evidenceIds":["old-e"]})
  self.db.put("evidence","old-e",{"id":"old-e","ownerWorkspaceId":"w","repositoryId":"repo"})
  self.db.put("repositories","repo",{"id":"repo","ownerWorkspaceId":"w","projectId":"p","status":"active","cloneUrl":"unused"})
 def run_proposal(self, key, change_type="tighten", include_base=True):
  payload={"driftFindingId":"f"}
  if include_base: payload["baseRuleVersionId"]="current"
  job=self.store.createAnalysisJob(self.ctx,{"type":"proposal","projectId":"p","payload":payload,"idempotencyKey":key})["job"]
  with tempfile.TemporaryDirectory() as root:
   directory=Path(root)/str(job["id"]); directory.mkdir(); (directory/".git").mkdir(); (directory/"package.json").write_text('{"dependencies":{"x":"2"}}')
   output={"proposals":[{"content":"Use x v2","rationale":"dependency changed","aiSummary":"updates x","changeType":change_type,"compatibility":{},"evidenceRefs":[{"path":"package.json","lineStart":1,"lineEnd":1}]}]}
   registry=JobHandlerRegistry(); registry.register_proposal(self.store,FixedStructuredGenerator(output),"reasoning-model")
   with patch("rulebranch.job_runtime.tempfile.mkdtemp", return_value=str(directory)):
    WorkerRuntime(self.store,object(),"unused",registry,tmp_root=Path(root)).run_job("w",str(job["id"]))
  return job
 def test_org_scope_proposal_uses_originating_evidence_project(self):
  rule=self.store.get(self.ctx,"rules","r")
  self.db.put("rules","r",{**rule,"scopeType":"organization","scopeId":"w","projectId":None})
  self.db.put("drift_findings","f",{**self.store.get(self.ctx,"drift_findings","f"),"projectId":"p","repositoryId":"repo"})
  job=self.run_proposal("proposal:f:org")
  self.assertEqual(self.store.get(self.ctx,"analysis_jobs",job["id"])["status"],"done")
  self.assertIsNotNone(self.store.get(self.ctx,"drift_findings","f").get("proposalVersionId"))
 def test_invalid_revision_change_type_fails_without_persisting_a_version(self):
  job=self.run_proposal("proposal:f:invalid", "update")
  saved=self.store.get(self.ctx,"analysis_jobs",job["id"])
  self.assertEqual(saved["status"],"failed")
  self.assertEqual([item["id"] for item in self.store.list(self.ctx,"rule_versions")],["current"])
  self.assertIsNone(self.store.get(self.ctx,"drift_findings","f").get("proposalVersionId"))
 def test_proposal_materializes_evidence_k16_and_reproposal_withdraws_d8(self):
  first=self.run_proposal("proposal:f:one"); first_version=self.store.get(self.ctx,"drift_findings","f")["proposalVersionId"]; version=self.store.get(self.ctx,"rule_versions",first_version)
  self.assertEqual(version["status"],"proposed"); self.assertTrue(version["evidenceIds"]); self.assertEqual(version["driftFindingIds"],["f","other"]); self.assertEqual(version["triggerId"],"t"); self.assertEqual(version["provenance"]["sourceType"],"ai"); self.assertTrue(version["rationale"]); self.assertTrue(version["aiSummary"]); self.assertEqual(self.store.get(self.ctx,"drift_findings","f")["status"],"accepted")
  # Simulate a process crash after createRuleVersion committed but before the job
  # status became done. The audit record is the atomic completion marker.
  ProposalJobHandler(self.store,FixedStructuredGenerator({}),"reasoning-model")(first,Path("/unused")); self.assertEqual(len(self.store.list(self.ctx,"rule_versions")),2)
  self.run_proposal("proposal:f:two"); second=self.store.get(self.ctx,"drift_findings","f")["proposalVersionId"]; self.assertNotEqual(first_version,second); self.assertEqual(self.store.get(self.ctx,"rule_versions",first_version)["status"],"withdrawn")
  self.assertEqual(self.store.get(self.ctx,"analysis_jobs",first["id"])["status"],"done")
 def test_obsolete_finding_cannot_create_proposal_for_new_current_version(self):
  self.db.put("drift_findings","f",{**self.store.get(self.ctx,"drift_findings","f"),"ruleVersionId":"old"})
  job=self.run_proposal("proposal:f:obsolete")
  self.assertEqual(self.store.get(self.ctx,"analysis_jobs",job["id"])["status"],"done")
  self.assertEqual([item["id"] for item in self.store.list(self.ctx,"rule_versions")],["current"])
  self.assertIsNone(self.store.get(self.ctx,"drift_findings","f").get("proposalVersionId"))
 def test_legacy_job_derives_immutable_base_from_finding(self):
  job=self.run_proposal("proposal:f:legacy",include_base=False)
  self.assertEqual(self.store.get(self.ctx,"analysis_jobs",job["id"])["status"],"done")
  self.assertIsNotNone(self.store.get(self.ctx,"drift_findings","f").get("proposalVersionId"))
 def test_current_version_change_during_generation_fails_without_partial_writes(self):
  test = self
  class RacingGenerator:
   def generate_structured(self, prompt, output_schema, model):
    rule=test.store.get(test.ctx,"rules","r")
    test.db.put("rules","r",{**rule,"currentVersionId":"new-current"})
    return {"proposals":[{"content":"Use x v2","rationale":"dependency changed","aiSummary":"updates x","changeType":"tighten","compatibility":{},"evidenceRefs":[{"path":"package.json","lineStart":1,"lineEnd":1}]}]}
  job=self.store.createAnalysisJob(self.ctx,{"type":"proposal","projectId":"p","payload":{"driftFindingId":"f","baseRuleVersionId":"current"},"idempotencyKey":"proposal:f:race"})["job"]
  with tempfile.TemporaryDirectory() as root:
   directory=Path(root)/str(job["id"]); directory.mkdir(); (directory/".git").mkdir(); (directory/"package.json").write_text('{"dependencies":{"x":"2"}}')
   registry=JobHandlerRegistry(); registry.register_proposal(self.store,RacingGenerator(),"reasoning-model")
   runtime=WorkerRuntime(self.store,object(),"unused",registry,tmp_root=Path(root))
   with patch("rulebranch.job_runtime.tempfile.mkdtemp", return_value=str(directory)):
    runtime.run_job("w",str(job["id"]))
    self.assertEqual(self.store.get(self.ctx,"analysis_jobs",job["id"])["status"],"failed")
    runtime.run_job("w",str(job["id"]))
  self.assertEqual(self.store.get(self.ctx,"analysis_jobs",job["id"])["status"],"done")
  self.assertEqual([item["id"] for item in self.store.list(self.ctx,"rule_versions")],["current"])
  self.assertIsNone(self.store.get(self.ctx,"drift_findings","f").get("proposalVersionId"))
if __name__ == "__main__": unittest.main()
