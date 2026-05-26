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
      org.opencontainers.image.source="https://github.com/gozippy/DockerRescueKit"

# restic + rclone are required by all remote storage adapters.
#
# We pull both as PINNED UPSTREAM BINARIES (not alpine apk packages). Reason:
# rclone and restic are statically-linked Go binaries that bundle their own
# copies of golang.org/x/crypto, google.golang.org/grpc, etc. Alpine's apk
# packages lag upstream by months, so the bundled-Go libraries inside the
# apk binaries carry stale CVEs (CVE-2026-46595/41179/41176 on alpine
# rclone 1.72.1-r3, all the x/crypto 0.41.0 findings on alpine restic).
# Docker Scout flags these even when the alpine layer itself is patched
# because the vulnerabilities live in code statically linked INTO the
# binary at upstream's compile time. Pulling upstream releases — which are
# rebuilt against current Go stdlib on every release — is the only fix
# that doesn't require alpine maintainers to ship a fresh apk first.
#
# Bump versions via --build-arg at image build time. Update the SHA256s
# from upstream when you bump:
#   rclone:  https://downloads.rclone.org/v${RCLONE_VERSION}/SHA256SUMS
#   restic:  https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS
ARG TARGETARCH
ARG RCLONE_VERSION=1.74.2
ARG RESTIC_VERSION=0.18.1
ARG RCLONE_SHA256_AMD64=72a806370072015ccbe4d81bcd348cc5eaf3beca6c65ba693fd43fb31fcca5b1
ARG RCLONE_SHA256_ARM64=bc2b2eb8269b743ed7bcea869f3782cfb4931e41efa53fc8befc6dc8308b7a50
ARG RESTIC_SHA256_AMD64=680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d
ARG RESTIC_SHA256_ARM64=87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45

# tini: proper PID-1 signal forwarding for graceful shutdown.
# fuse3 + ca-certificates: transitive deps for rclone mounts / TLS.
RUN apk add --no-cache tini ca-certificates fuse3 \
 && mkdir -p /data /backups \
 && apk add --no-cache --virtual .upstream-fetch-deps wget unzip bzip2 \
 && case "${TARGETARCH:-amd64}" in \
      amd64) RCLONE_SHA="${RCLONE_SHA256_AMD64}"; RESTIC_SHA="${RESTIC_SHA256_AMD64}"; RCLONE_ARCH="amd64"; RESTIC_ARCH="amd64" ;; \
      arm64) RCLONE_SHA="${RCLONE_SHA256_ARM64}"; RESTIC_SHA="${RESTIC_SHA256_ARM64}"; RCLONE_ARCH="arm64"; RESTIC_ARCH="arm64" ;; \
      *)     echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && wget -qO /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}.zip" \
 && echo "${RCLONE_SHA}  /tmp/rclone.zip" | sha256sum -c - \
 && unzip -j /tmp/rclone.zip "rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}/rclone" -d /usr/local/bin/ \
 && chmod +x /usr/local/bin/rclone \
 && wget -qO /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${RESTIC_ARCH}.bz2" \
 && echo "${RESTIC_SHA}  /tmp/restic.bz2" | sha256sum -c - \
 && bzip2 -d /tmp/restic.bz2 \
 && mv /tmp/restic /usr/local/bin/restic \
 && chmod +x /usr/local/bin/restic \
 && apk del .upstream-fetch-deps \
 && rm -f /tmp/rclone.zip

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
