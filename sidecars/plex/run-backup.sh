#!/usr/bin/env bash
# Performs one backup of $PLEX_CONFIG_SOURCE according to $BACKUP_TYPE.
# Called from entrypoint.sh's scheduler loop and from BACKUP_ON_START.
#
# Lifecycle:
#   1. pre-backup.sh   (clear transcode cache, optionally stop Plex)
#   2. <backup engine> (tar for local, restic for everything else)
#   3. retention prune (count- or tier-based per env)
#   4. post-backup     (always-runs restart of Plex if it was stopped)
#
# The post step lives inline at the bottom of this script so the `trap`
# ensures Plex restarts even on a backup-engine crash.

set -uo pipefail

log() {
  printf '{"ts":"%s","level":"%s","sidecar":"drk-plex","phase":"backup","msg":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${1}" \
    "$(printf '%s' "${2}" | jq -Rs '.')"
}

post_restart() {
  # Always restart Plex if we stopped it. Don't gate on backup success —
  # an unstopped Plex is worse than a missing backup.
  if [[ "${STOP_PLEX_BEFORE_BACKUP}" == "true" && -S "/var/run/docker.sock" ]]; then
    log info "restarting ${PLEX_CONTAINER}"
    docker start "${PLEX_CONTAINER}" \
      || log error "docker start ${PLEX_CONTAINER} failed — operator intervention required"
  fi
}

# Defer-style: always run post_restart, even on error/exit.
trap post_restart EXIT

# --- pre-backup -----------------------------------------------------------
/usr/local/bin/pre-backup.sh

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log info "starting backup (type=${BACKUP_TYPE})"

# --- backup engine --------------------------------------------------------
case "${BACKUP_TYPE}" in
  local)
    # Simple tarball with the timestamp embedded in the filename.
    # Compression: gzip via tar's built-in to avoid spawning pigz.
    out_name="plex-config-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    out_path="${BACKUP_DIR}/${out_name}"
    log info "writing tarball to ${out_path}"

    if ! tar -czf "${out_path}.tmp" -C "${PLEX_CONFIG_SOURCE}" .; then
      log error "tar exited non-zero — leaving partial file at ${out_path}.tmp for inspection"
      exit 1
    fi
    mv "${out_path}.tmp" "${out_path}"

    # Count-based retention.
    if [[ -n "${RETENTION_KEEP_COUNT:-}" ]]; then
      log info "applying count-based retention (keep=${RETENTION_KEEP_COUNT})"
      # shellcheck disable=SC2012
      ls -1t "${BACKUP_DIR}"/plex-config-*.tar.gz 2>/dev/null \
        | tail -n +"$((RETENTION_KEEP_COUNT + 1))" \
        | while read -r old; do
            log info "pruning ${old}"
            rm -f "$old"
          done
    fi
    ;;

  s3|sftp|b2|azure)
    # restic handles dedup, encryption, retention.
    if ! restic backup "${PLEX_CONFIG_SOURCE}" \
        --tag plex-config \
        --tag "host=${HOSTNAME}" \
        --host "drk-plex"; then
      log error "restic backup exited non-zero"
      exit 1
    fi

    log info "applying tiered retention (daily=${RETENTION_KEEP_DAILY} weekly=${RETENTION_KEEP_WEEKLY} monthly=${RETENTION_KEEP_MONTHLY})"
    if ! restic forget \
        --tag plex-config \
        --keep-daily   "${RETENTION_KEEP_DAILY}" \
        --keep-weekly  "${RETENTION_KEEP_WEEKLY}" \
        --keep-monthly "${RETENTION_KEEP_MONTHLY}" \
        --prune; then
      log warn "restic forget/prune exited non-zero (backup itself succeeded)"
    fi
    ;;

  rclone)
    # rclone copies into a remote bucket as a plain tarball — useful for
    # endpoints restic doesn't natively support.
    out_name="plex-config-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    local_tmp="/tmp/${out_name}"
    log info "staging tarball at ${local_tmp}"
    if ! tar -czf "${local_tmp}" -C "${PLEX_CONFIG_SOURCE}" .; then
      log error "tar exited non-zero"
      rm -f "${local_tmp}"
      exit 1
    fi

    log info "uploading via rclone to ${RCLONE_REMOTE}:${RCLONE_PATH}"
    if ! rclone copyto "${local_tmp}" "${RCLONE_REMOTE}:${RCLONE_PATH}/${out_name}"; then
      log error "rclone copyto exited non-zero — local tmp left at ${local_tmp} for inspection"
      exit 1
    fi
    rm -f "${local_tmp}"

    # Best-effort retention via rclone's --min-age / lsf.
    if [[ -n "${RETENTION_KEEP_COUNT:-}" ]]; then
      log info "applying count-based retention via rclone (keep=${RETENTION_KEEP_COUNT})"
      rclone lsf --files-only "${RCLONE_REMOTE}:${RCLONE_PATH}" \
        | grep -E '^plex-config-.*\.tar\.gz$' \
        | sort -r \
        | tail -n +"$((RETENTION_KEEP_COUNT + 1))" \
        | while read -r old; do
            log info "pruning remote ${old}"
            rclone delete "${RCLONE_REMOTE}:${RCLONE_PATH}/${old}" || true
          done
    fi
    ;;
esac

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log info "backup complete (started=${started_at} finished=${finished_at})"
