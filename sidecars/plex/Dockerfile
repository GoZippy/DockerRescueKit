# syntax=docker/dockerfile:1.6
# gozippy/drk-plex — stack-specific backup side-car for Plex Media Server
#
# Bundles restic + rclone + docker-cli + a small backup loop tuned for the
# Plex /config directory. Does NOT back up media files (those live on a
# separate, much larger, file-level backup — point your own restic/rclone
# at /data/media if you want that).
#
# Build:
#   docker build -t gozippy/drk-plex:0.1.0 sidecars/plex
#
# Run (compose example is in this directory):
#   docker run -d --name drk-plex \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v plex-config:/source/config:ro \
#     -v drk-plex-backups:/backups \
#     -e PLEX_CONTAINER=plex \
#     -e BACKUP_SCHEDULE='0 4 * * *' \
#     gozippy/drk-plex:0.1.0

FROM alpine:3.19

# --- packages -------------------------------------------------------------
# restic + rclone: backup engines
# docker-cli: needed to stop Plex via the host socket pre-backup
# tini: PID-1 reaper + signal forwarder
# bash, coreutils, findutils: scripting
# tzdata: cron expressions honor TZ
# curl, jq: ad-hoc health probes, log emission
# ca-certificates: TLS for restic/rclone to S3/B2/Azure/etc
RUN apk add --no-cache \
      restic \
      rclone \
      docker-cli \
      tini \
      bash \
      coreutils \
      findutils \
      tzdata \
      curl \
      jq \
      ca-certificates \
 && addgroup -S -g 1100 drk \
 && adduser  -S -u 1100 -G drk -s /bin/bash drk \
 && mkdir -p /backups /restic-cache /var/log/drk \
 && chown -R drk:drk /backups /restic-cache /var/log/drk

# --- scripts --------------------------------------------------------------
COPY --chown=drk:drk entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=drk:drk pre-backup.sh /usr/local/bin/pre-backup.sh
COPY --chown=drk:drk run-backup.sh /usr/local/bin/run-backup.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/pre-backup.sh \
             /usr/local/bin/run-backup.sh

# --- defaults -------------------------------------------------------------
# Every default is overrideable; the design is opinionated but not silent.
ENV PLEX_CONTAINER="plex" \
    PLEX_CONFIG_SOURCE="/source/config" \
    BACKUP_DIR="/backups" \
    BACKUP_SCHEDULE="0 4 * * *" \
    BACKUP_TYPE="local" \
    BACKUP_ON_START="false" \
    STOP_PLEX_BEFORE_BACKUP="true" \
    CLEAR_TRANSCODE_CACHE="true" \
    RESTIC_CACHE_DIR="/restic-cache" \
    RETENTION_KEEP_DAILY="7" \
    RETENTION_KEEP_WEEKLY="4" \
    RETENTION_KEEP_MONTHLY="6" \
    TZ="UTC" \
    DRK_SIDECAR="drk-plex" \
    DRK_SIDECAR_VERSION="0.1.0"

# --- labels (OCI + Docker Hub / Marketplace metadata) ---------------------
LABEL org.opencontainers.image.title="Docker Rescue Kit — Plex Side-Car" \
      org.opencontainers.image.description="Standalone backup side-car for Plex Media Server config directory. Restic + rclone with safe quiesce and tiered retention." \
      org.opencontainers.image.vendor="Zippy Technologies LLC" \
      org.opencontainers.image.source="https://github.com/gozippy/DockerRescueKit" \
      org.opencontainers.image.url="https://github.com/gozippy/DockerRescueKit/tree/main/sidecars/plex" \
      org.opencontainers.image.licenses="LicenseRef-ZippyTech-SourceAvailable-Commercial-License-1.3" \
      com.gozippy.drk.sidecar="drk-plex" \
      com.gozippy.drk.sidecar.version="0.1.0" \
      com.gozippy.drk.requires.docker-socket="true (only when STOP_PLEX_BEFORE_BACKUP=true)"

# --- runtime --------------------------------------------------------------
USER drk
WORKDIR /home/drk
VOLUME ["/backups", "/restic-cache"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
