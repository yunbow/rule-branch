# Build context MUST be the monorepo root (docker build -f apps/web/Dockerfile .),
# not apps/web: src/shared/contracts.ts resolves contracts/enums.json and
# contracts/limits.json relative to the repo root (four levels up from
# apps/web/src/shared), so the image needs that directory alongside apps/web.
FROM node:24-slim AS dependencies
WORKDIR /workspace/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-slim AS builder
WORKDIR /workspace/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /workspace/apps/web/node_modules ./node_modules
COPY apps/web ./
COPY contracts /workspace/contracts
# Every route is force-dynamic (src/app/layout.tsx), so the build never needs real
# Firestore/session credentials — those are only read at request time, from Cloud Run's
# injected env vars (see infra/main.tf's google_cloud_run_v2_service.web).
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /workspace/apps/web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Keep the non-root UID stable and give only Next's writable cache directory to
# the application process.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && mkdir -p .next/cache \
    && chown -R nextjs:nodejs .next
# Next's traced standalone output contains only production runtime dependencies.
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/public ./public
# These SDKs are externalized from Turbopack because they resolve modules at
# runtime. The standalone tracer misses Cloud Tasks' dynamically loaded protobuf
# JSON, so retain their complete package directories in the runtime image.
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/node_modules/@google-cloud/tasks ./node_modules/@google-cloud/tasks
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/web/node_modules/firebase-admin ./node_modules/firebase-admin
# contracts.ts intentionally reads the shared JSON contracts from the monorepo
# root at runtime, so retain that path in the otherwise minimal image.
COPY --from=builder --chown=nextjs:nodejs /workspace/contracts /workspace/contracts
USER nextjs
EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
# infra/main.tf's web_image is expected to be built from this Dockerfile.
# Cloud Run can override PORT; the standalone server reads it directly.
CMD ["node", "server.js"]
