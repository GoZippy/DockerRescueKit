# syntax=docker/dockerfile:1.6
# Docker Desktop Extension image.
# Packages the backend + built UI + extension metadata into a single image
# that `docker extension install` can consume.
#
# Self-contained: no pulls from unpublished gozippy/* tags.
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

# ─── Stage 1b: rclone from source ───────────────────────────────────────────
# rclone publishes prebuilt binaries that lag the source on dep bumps.
# v1.74.2 source go.mod already pins golang.org/x/crypto v0.52.0 and
# google.golang.org/grpc v1.80.0 (both ABOVE the CVE-2026-46595 / -42508 /
# -39832..39834 fix versions), but the binary at downloads.rclone.org was
# compiled before that bump and still bundles the vulnerable libs. Building
# from the git tag picks up the fixed deps.
FROM golang:1.25-alpine AS rclone-build
RUN apk add --no-cache git
ARG RCLONE_VERSION=1.74.2
WORKDIR /src
RUN git clone --depth 1 --branch v${RCLONE_VERSION} https://github.com/rclone/rclone.git .
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -tags noselfupdate -o /rclone .

# ─── Stage 1c: restic from source ───────────────────────────────────────────
# restic v0.18.1 source still pins x/crypto v0.41.0 and x/net v0.43.0 (both
# BELOW CVE fix versions). We `go get` newer versions before build to cut
# the bundled-Go CVEs. The crypto APIs restic uses (SCrypt, Poly1305,
# Salsa20) are stable across these versions.
FROM golang:1.25-alpine AS restic-build
RUN apk add --no-cache git
ARG RESTIC_VERSION=0.18.1
WORKDIR /src
RUN git clone --depth 1 --branch v${RESTIC_VERSION} https://github.com/restic/restic.git .
RUN go get golang.org/x/crypto@v0.52.0 golang.org/x/net@v0.55.0 google.golang.org/grpc@v1.81.1 \
 && go mod tidy
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /restic ./cmd/restic

# ─── Stage 2: final ──────────────────────────────────────────────────────────
FROM node:20-alpine AS final

LABEL org.opencontainers.image.title="Docker Rescue Kit" \
      org.opencontainers.image.description="Backup and restore for Docker containers, volumes, and stacks" \
      org.opencontainers.image.vendor="DockerRescueKit" \
      org.opencontainers.image.source="https://github.com/gozippy/DockerRescueKit" \
      com.docker.desktop.extension.api.version="0.3.4" \
      com.docker.desktop.extension.icon="https://raw.githubusercontent.com/gozippy/DockerRescueKit/main/drk-icon.svg" \
      com.docker.extension.screenshots='[{"alt":"Dashboard","url":"https://raw.githubusercontent.com/gozippy/DockerRescueKit/main/docs/screenshots/01-dashboard.png"},{"alt":"Policies","url":"https://raw.githubusercontent.com/gozippy/DockerRescueKit/main/docs/screenshots/02-policies.png"},{"alt":"Settings","url":"https://raw.githubusercontent.com/gozippy/DockerRescueKit/main/docs/screenshots/03-settings.png"}]' \
      com.docker.extension.detailed-description="Docker Rescue Kit is a complete backup and restore solution for Docker. It captures point-in-time snapshots of containers, named volumes, and full compose stacks, with scheduled policies, retention rules, and one-click restore. Backups can be stored locally or pushed to remote destinations (SMB, S3, and any rclone-supported provider). Built for homelab and small-team operators who need reliable rollback without leaving Docker Desktop." \
      com.docker.extension.publisher-url="https://github.com/gozippy/DockerRescueKit" \
      com.docker.extension.additional-urls='[{"title":"Changelog","url":"https://github.com/gozippy/DockerRescueKit/blob/main/CHANGELOG.md"},{"title":"Documentation","url":"https://github.com/gozippy/DockerRescueKit/blob/main/README.md"}]' \
      com.docker.extension.categories="backup,utility-tools" \
      com.docker.extension.changelog="https://github.com/gozippy/DockerRescueKit/blob/main/CHANGELOG.md"

# tini + ca-certificates + fuse3 are the only runtime deps we still take
# from alpine apk. rclone and restic come from the from-source build stages
# (rclone-build, restic-build) above — see those stages for the CVE rationale.
#
# Strip the bundled npm + npx from the node image — we run via `node`
# directly (see CMD) and never invoke npm at runtime. Removing them drops
# ~50MB AND eliminates every CVE in npm's transitive deps (tar, minimatch,
# glob, cross-spawn, etc. all bundled inside /usr/local/lib/node_modules/npm).
RUN apk add --no-cache tini ca-certificates fuse3 \
 && mkdir -p /data /run/guest-services \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Copy from-source-built CVE-clean binaries
COPY --from=rclone-build /rclone /usr/local/bin/rclone
COPY --from=restic-build /restic /usr/local/bin/restic

# Copy runtime artifacts from the builder stage
COPY --from=builder /workspace/node_modules                     ./node_modules
COPY --from=builder /workspace/packages/shared/package.json     ./packages/shared/package.json
COPY --from=builder /workspace/packages/backend/package.json    ./packages/backend/package.json
COPY --from=builder /workspace/packages/backend/dist            ./packages/backend/dist
COPY --from=builder /workspace/packages/extension/dist          /ui

# Extension metadata + assets at image root (Docker Desktop reads these).
# The compose file MUST be named compose.yaml (or docker-compose.yaml) per
# the marketplace validator regex.
COPY metadata.json                /metadata.json
COPY docker-compose.extension.yml /compose.yaml
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
