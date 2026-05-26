# syntax=docker/dockerfile:1.6
# gozippy/drk-vaultwarden — stack-specific backup side-car for Vaultwarden
#
# The most paranoid side-car in the V-1 series, by design. Vaultwarden stores
# your password vault, attachments, master key, and sends table — there is no
# "nice to have" file in /data. Losing any of it costs you your vault.
#
# Defaults reflect that:
#   * HOURLY default schedule (vs daily on most side-cars)
#   * Atomic SQLite `.backup` — no service stop required
#   * Tiered retention skewed toward more recent copies
#   * Image emits structured JSON logs so DRK's audit scraper can pick them up
#
# Build:
#   docker build -t gozippy/drk-vaultwarden:0.1.0 sidecars/vaultwarden
#
# Run (compose example is in this directory):
#   docker run -d --name drk-vaultwarden \
#     -v vw-data:/source/data:ro \
#     -v drk-vw-backups:/backups \
#     -e BACKUP_SCHEDULE='0 * * * *' \
#     gozippy/drk-vaultwarden:0.1.0

FROM alpine:3.19

# --- packages -------------------------------------------------------------
# restic + rclone: backup engines
# sqlite: needed for the atomic `.backup` command outside the container
# tini: PID-1 reaper + signal forwarder
# bash, coreutils, findutils: scripting
# tzdata: cron expressions honor TZ
# jq, curl: ad-hoc structured logging
# ca-certificates: TLS for restic/rclone to S3/B2/Azure/etc
#
# Note: docker-cli is intentionally NOT included. Vaultwarden does NOT need to
# be stopped for a consistent backup (SQLite `.backup` is atomic), so the
# socket mount that drk-plex needs would be a gratuitous attack surface here.
RUN apk add --no-cache \
      restic \
      rclone \
      sqlite \
      tini \
      bash \
      coreutils \
      findutils \
      tzdata \
      jq \
      curl \
      ca-certificates \
 && addgroup -S -g 1100 drk \
 && adduser  -S -u 1100 -G drk -s /bin/bash drk \
 && mkdir -p /backups /restic-cache /var/log/drk \
 && chown -R drk:drk /backups /restic-cache /var/log/drk

# --- scripts --------------------------------------------------------------
COPY --chown=drk:drk entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=drk:drk run-backup.sh /usr/local/bin/run-backup.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/run-backup.sh

# --- defaults -------------------------------------------------------------
ENV VW_DATA_SOURCE="/source/data" \
    VW_DB_FILENAME="db.sqlite3" \
    BACKUP_DIR="/backups" \
    BACKUP_SCHEDULE="0 * * * *" \
    BACKUP_TYPE="local" \
    BACKUP_ON_START="false" \
    RESTIC_CACHE_DIR="/restic-cache" \
    RETENTION_KEEP_HOURLY="24" \
    RETENTION_KEEP_DAILY="14" \
    RETENTION_KEEP_WEEKLY="8" \
    RETENTION_KEEP_MONTHLY="12" \
    TZ="UTC" \
    DRK_SIDECAR="drk-vaultwarden" \
    DRK_SIDECAR_VERSION="0.1.0"

# --- labels (OCI + Docker Hub metadata) -----------------------------------
LABEL org.opencontainers.image.title="Docker Rescue Kit — Vaultwarden Side-Car" \
      org.opencontainers.image.description="Paranoid backup side-car for Vaultwarden. Hourly atomic SQLite snapshots + restic/rclone offsite. No Docker socket required." \
      org.opencontainers.image.vendor="Zippy Technologies LLC" \
      org.opencontainers.image.source="https://github.com/gozippy/DockerRescueKit" \
      org.opencontainers.image.url="https://github.com/gozippy/DockerRescueKit/tree/main/sidecars/vaultwarden" \
      org.opencontainers.image.licenses="LicenseRef-ZippyTech-SourceAvailable-Commercial-License-1.3" \
      com.gozippy.drk.sidecar="drk-vaultwarden" \
      com.gozippy.drk.sidecar.version="0.1.0" \
      com.gozippy.drk.requires.docker-socket="false"

# --- runtime --------------------------------------------------------------
USER drk
WORKDIR /home/drk
VOLUME ["/backups", "/restic-cache"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
