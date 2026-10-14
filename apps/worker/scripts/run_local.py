"""Emulator-only queued analysis-job runner."""
import os, time
from rulebranch.main import build_runtime

def poll_once(runtime: object) -> None:
    store = getattr(runtime, "store")
    for snapshot in store._firestore.collection("analysis_jobs").where("status", "==", "queued").stream():
        job = snapshot.to_dict() or {}
        getattr(runtime, "run_job")(str(job["ownerWorkspaceId"]), str(job["id"]))

def main() -> None:
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"): raise SystemExit("run_local.py requires FIRESTORE_EMULATOR_HOST (local development only)")
    # The polling runner never exposes the authenticated HTTP entrypoint. Supply a
    # local-only placeholder so production can require an exact Cloud Tasks identity
    # without breaking emulator workflows that intentionally omit Cloud Tasks env.
    env = {**os.environ, "WORKER_SERVICE_ACCOUNT_EMAIL": os.environ.get("WORKER_SERVICE_ACCOUNT_EMAIL", "local-worker@example.invalid")}
    runtime = build_runtime(env)
    while True:
        poll_once(runtime)
        time.sleep(2)
if __name__ == "__main__": main()
