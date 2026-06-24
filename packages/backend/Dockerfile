# syntax=docker/dockerfile:1.6
# packages/backend/Dockerfile — multi-stage production build
# Build context must be the REPO ROOT so the monorepo workspace is available:
#   docker build -f packages/backend/Dockerfile .

# ─── Stage 1: builder ────────────────────────────────────────────────────────
# Pinned to multi-arch index digest so a base republish under the same tag
# cannot silently change what we build. Dependabot updates the tag+digest
# together. Re-resolve manually via:
#   docker buildx imagetools inspect node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /workspace

# native addon build tools (better-sqlite3 needs python3/make/g++)
RUN apk add --no-cache python3 make g++ \
 && ln -sf /usr/bin/python3 /usr/bin/python

# Copy root workspace manifests first (layer-cache friendly)
COPY package.json package-lock.json* ./

# Copy package manifests for the packages we need to build.
# shared/ is copied as a whole BEFORE `npm ci` because the root
# package.json declares a postinstall hook that builds it via tsc — that
# fails if shared/src/ + tsconfig.json aren't on disk when npm ci runs.
# (The extension Dockerfile at repo root already has this fix — see its
# line 30; the standalone Dockerfile here was missed in that change.)
COPY packages/shared/                 ./packages/shared/
COPY packages/backend/package.json    ./packages/backend/
COPY packages/extension/package.json  ./packages/extension/

# Install ALL deps (including devDependencies — we need tsc).
# The postinstall in root package.json compiles shared into dist/ here.
RUN npm ci --workspaces --include-workspace-root

# Build backend (tsc compiles src/ → dist/ per tsconfig outDir)
COPY packages/backend/   ./packages/backend/
RUN npm run build --workspace=@docker-rescue-kit/backend

# Build extension UI so the final image can serve it
COPY packages/extension/ ./packages/extension/
RUN npm run build --workspace=@docker-rescue-kit/extension

# Prune devDependencies; keeps node_modules slim for the final stage copy
RUN npm prune --omit=dev

# ─── Stage 1b: rclone from source ───────────────────────────────────────────
# rclone publishes prebuilt binaries that lag the source on dep bumps.
# v1.74.3 source go.mod already pins golang.org/x/crypto v0.52.0 and
# google.golang.org/grpc v1.80.0 (both ABOVE the CVE-2026-46595 / -42508 /
# -39832..39834 fix versions), but the binary at downloads.rclone.org was
# compiled before that bump and still bundles the vulnerable libs. Building
# from the git tag picks up the fixed deps.
FROM golang:1.26-alpine@sha256:7a3e50096189ad57c9f9f865e7e4aa8585ed1585248513dc5cda498e2f41812c AS rclone-build
RUN apk add --no-cache git
ARG RCLONE_VERSION=1.74.3
WORKDIR /src
RUN git clone --depth 1 --branch v${RCLONE_VERSION} https://github.com/rclone/rclone.git .
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -tags noselfupdate -o /rclone .

# ─── Stage 1c: restic from source ───────────────────────────────────────────
# restic v0.18.1 source still pins x/crypto v0.41.0 and x/net v0.43.0 (both
# BELOW CVE fix versions). We `go get` newer versions before build to cut
# the bundled-Go CVEs. The crypto APIs restic uses (SCrypt, Poly1305,
# Salsa20) are stable across these versions.
FROM golang:1.26-alpine@sha256:7a3e50096189ad57c9f9f865e7e4aa8585ed1585248513dc5cda498e2f41812c AS restic-build
RUN apk add --no-cache git
ARG RESTIC_VERSION=0.18.1
WORKDIR /src
RUN git clone --depth 1 --branch v${RESTIC_VERSION} https://github.com/restic/restic.git .
RUN go get golang.org/x/crypto@v0.52.0 golang.org/x/net@v0.55.0 google.golang.org/grpc@v1.81.1 \
 && go mod tidy
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /restic ./cmd/restic

# ─── Stage 2: final ──────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS final

LABEL org.opencontainers.image.title="Docker Rescue Kit – Backend" \
      org.opencontainers.image.description="Backup and restore service for Docker containers, volumes, and stacks" \
      org.opencontainers.image.source="https://github.com/gozippy/DockerRescueKit"

# tini + ca-certificates + fuse3 are the only runtime deps we still take
# from alpine apk. rclone and restic come from the from-source build stages
# (see Stage 1b / Stage 1c above) — built against current x/crypto/x/net/grpc
# so the bundled-Go CVEs that affect both upstream prebuilt binaries (rclone)
# and upstream source (restic) are eliminated at compile time.
#
# Strip the bundled npm + npx from the node image — we run via `node`
# directly (see CMD) and never invoke npm at runtime. Removing them drops
# ~50MB AND eliminates every CVE in npm's transitive deps (tar, minimatch,
# glob, cross-spawn, etc. all bundled inside /usr/local/lib/node_modules/npm).
RUN apk add --no-cache tini ca-certificates fuse3 \
 && mkdir -p /data /backups \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy from-source-built CVE-clean binaries
COPY --from=rclone-build /rclone /usr/local/bin/rclone
COPY --from=restic-build /restic /usr/local/bin/restic

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
