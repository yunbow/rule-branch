# Build context MUST be the monorepo root (docker build -f apps/worker/Dockerfile .),
# not apps/worker: src/rulebranch/contracts.py resolves contracts/*.json relative to
# the repo root (parents[4] from contracts.py, i.e. four levels up from
# apps/worker/src/rulebranch), so the image needs that directory alongside apps/worker.
# Pin the official multi-architecture image index.  Keep the readable tag so
# automated scanners can identify the intended release while the digest makes
# builds reproducible and prevents a mutable-tag substitution.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016
WORKDIR /workspace/apps/worker
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY apps/worker ./
COPY contracts /workspace/contracts
RUN python -m pip install --disable-pip-version-check --no-cache-dir . \
    && python -m pip check
ENV PYTHONPATH=/workspace/apps/worker/src
# infra/main.tf's worker_image is expected to be built from this Dockerfile.
CMD ["python", "-m", "rulebranch.main"]
