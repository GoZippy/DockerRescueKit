# syntax=docker/dockerfile:1.6
# Docker Desktop Extension image.
# Packages the backend + built UI + extension metadata into a single image
# that `docker extension install` can consume.
#
# Self-contained: no pulls from unpublished dockerrescuekit/* tags.
# Build context must be the REPO ROOT:
#   docker build -t drk-extension:dev -f Dockerfile .

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

# Install ALL deps (including devDependencies — we need tsc / vite)
RUN npm ci --workspaces --include-workspace-root

# shared/ is type-only — copy sources for tsc to resolve imports
COPY packages/shared/    ./packages/shared/

# Build backend (tsc compiles src/ → dist/ per tsconfig outDir)
COPY packages/backend/   ./packages/backend/
RUN npm run build --workspace=@docker-rescue-kit/backend

# Build extension UI bundle (VITE_TRANSPORT=extension routes via ddClient)
COPY packages/extension/ ./packages/extension/
RUN npm run build:extension --workspace=@docker-rescue-kit/extension

# Prune devDependencies; keeps node_modules slim for the final stage copy
RUN npm prune --omit=dev

# ─── Stage 2: final ──────────────────────────────────────────────────────────
FROM node:20-alpine AS final

LABEL org.opencontainers.image.title="Docker Rescue Kit" \
      org.opencontainers.image.description="Backup and restore for Docker containers, volumes, and stacks" \
      org.opencontainers.image.vendor="DockerRescueKit" \
      org.opencontainers.image.source="https://github.com/DockerRescueKit/DockerRescueKit" \
      com.docker.desktop.extension.api.version="0.3.4" \
      com.docker.desktop.extension.icon="drk-icon.svg" \
      com.docker.extension.screenshots='[{"alt":"Dashboard","url":"https://raw.githubusercontent.com/DockerRescueKit/DockerRescueKit/main/docs/screenshots/01-dashboard.png"},{"alt":"Policies","url":"https://raw.githubusercontent.com/DockerRescueKit/DockerRescueKit/main/docs/screenshots/02-policies.png"},{"alt":"Settings","url":"https://raw.githubusercontent.com/DockerRescueKit/DockerRescueKit/main/docs/screenshots/03-settings.png"}]' \
      com.docker.extension.detailed-description="Docker Rescue Kit is a complete backup and restore solution for Docker. It captures point-in-time snapshots of containers, named volumes, and full compose stacks, with scheduled policies, retention rules, and one-click restore. Backups can be stored locally or pushed to remote destinations (SMB, S3, and any rclone-supported provider). Built for homelab and small-team operators who need reliable rollback without leaving Docker Desktop." \
      com.docker.extension.publisher-url="https://github.com/DockerRescueKit/DockerRescueKit" \
      com.docker.extension.additional-urls='[{"title":"Changelog","url":"https://github.com/DockerRescueKit/DockerRescueKit/blob/main/CHANGELOG.md"},{"title":"Documentation","url":"https://github.com/DockerRescueKit/DockerRescueKit/blob/main/README.md"}]' \
      com.docker.extension.categories="backup,utility-tools" \
      com.docker.extension.changelog="https://github.com/DockerRescueKit/DockerRescueKit/blob/main/CHANGELOG.md"

# restic + rclone are required by all remote storage adapters.
RUN apk add --no-cache tini restic rclone ca-certificates fuse3 \
 && mkdir -p /data /run/guest-services

WORKDIR /app

# Copy runtime artifacts from the builder stage
COPY --from=builder /workspace/node_modules                     ./node_modules
COPY --from=builder /workspace/packages/shared/package.json     ./packages/shared/package.json
COPY --from=builder /workspace/packages/backend/package.json    ./packages/backend/package.json
COPY --from=builder /workspace/packages/backend/dist            ./packages/backend/dist
COPY --from=builder /workspace/packages/extension/dist          /ui

# Extension metadata + assets at image root (Docker Desktop reads these)
COPY metadata.json                /metadata.json
COPY docker-compose.extension.yml /docker-compose.extension.yml
COPY drk-icon.svg                 /drk-icon.svg

# Socket transport — Docker Desktop SDK discovers /run/guest-services/drk.sock
ENV NODE_ENV=production \
    DRK_TRANSPORT=socket \
    DRK_SOCKET_PATH=/run/guest-services/drk.sock \
    DRK_DATA_DIR=/data \
    DRK_UI_DIR=/ui

VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/backend/dist/backend/src/index.js"]
