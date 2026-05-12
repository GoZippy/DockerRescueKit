# syntax=docker/dockerfile:1.6
# packages/backend/Dockerfile — multi-stage production build
# Build context must be the REPO ROOT so the monorepo workspace is available:
#   docker build -f packages/backend/Dockerfile .

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /workspace

# native addon build tools (better-sqlite3 needs python3/make/g++)
RUN apk add --no-cache python3 make g++ \
 && ln -sf /usr/bin/python3 /usr/bin/python

# Copy root workspace manifests first (layer-cache friendly)
COPY package.json package-lock.json* ./

# Copy package manifests for the packages we need to build
COPY packages/shared/package.json     ./packages/shared/
COPY packages/backend/package.json    ./packages/backend/
COPY packages/extension/package.json  ./packages/extension/

# Install ALL deps (including devDependencies — we need tsc)
RUN npm ci --workspaces --include-workspace-root

# shared/ is type-only (main → src/types.ts, no runtime exports), so we just
# copy sources for tsc to resolve imports — no build step needed.
COPY packages/shared/    ./packages/shared/

# Build backend (tsc compiles src/ → dist/ per tsconfig outDir)
COPY packages/backend/   ./packages/backend/
RUN npm run build --workspace=@docker-rescue-kit/backend

# Build extension UI so the final image can serve it
COPY packages/extension/ ./packages/extension/
RUN npm run build --workspace=@docker-rescue-kit/extension

# Prune devDependencies; keeps node_modules slim for the final stage copy
RUN npm prune --omit=dev

# ─── Stage 2: final ──────────────────────────────────────────────────────────
FROM node:20-alpine AS final

LABEL org.opencontainers.image.title="Docker Rescue Kit – Backend" \
      org.opencontainers.image.description="Backup and restore service for Docker containers, volumes, and stacks" \
      org.opencontainers.image.source="https://github.com/DockerRescueKit/DockerRescueKit"

# restic + rclone are required by all remote storage adapters.
# restic:  official alpine build, battle-tested.
# rclone:  single static binary that handles ~40 cloud providers.
# tini:    proper PID-1 signal forwarding for graceful shutdown.
# fuse3 + ca-certificates: transitive deps for rclone mounts / TLS.
RUN apk add --no-cache tini restic rclone ca-certificates fuse3 \
 && mkdir -p /data /backups

# Create a non-root user. The `node` base image already owns uid/gid 1000
# (the built-in `node` user), so we pick 1100 to avoid the collision.
RUN addgroup -g 1100 drk && adduser -u 1100 -G drk -s /sbin/nologin -D drk \
 && chown drk:drk /data /backups

# Add `drk` to the host's docker group so /var/run/docker.sock is readable.
# Most Linux hosts use gid 999 for the docker group; Synology/QNAP use 100.
# Override at build time:  docker build --build-arg DOCKER_GID=100 ...
# At runtime, docker-compose ALSO sets `group_add` so the running container
# gets supplementary group access regardless of the baked-in value.
ARG DOCKER_GID=999
RUN if getent group ${DOCKER_GID}; then \
        addgroup drk $(getent group ${DOCKER_GID} | cut -d: -f1); \
    else \
        addgroup -g ${DOCKER_GID} docker && addgroup drk docker; \
    fi

WORKDIR /app

# Copy only what the runtime needs — no src, no dev tooling
COPY --from=builder --chown=drk:drk /workspace/node_modules                     ./node_modules
COPY --from=builder --chown=drk:drk /workspace/packages/shared/package.json     ./packages/shared/package.json
COPY --from=builder --chown=drk:drk /workspace/packages/backend/package.json    ./packages/backend/package.json
COPY --from=builder --chown=drk:drk /workspace/packages/backend/dist            ./packages/backend/dist
COPY --from=builder --chown=drk:drk /workspace/packages/extension/dist          ./public

# Stateful mount points
VOLUME ["/data", "/backups"]

EXPOSE 42880

ENV NODE_ENV=production \
    DRK_DATA_DIR=/data \
    DRK_UI_DIR=/app/public \
    PORT=42880

USER drk

# tini as PID 1 for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/backend/dist/backend/src/index.js"]
