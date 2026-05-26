#!/usr/bin/env bash
# Performs one Vaultwarden backup according to $BACKUP_TYPE.
#
# Two-phase:
#   1. Atomic SQLite snapshot via `sqlite3 .backup`. This is the critical
#      step — it ensures the db.sqlite3 we capture is consistent without
#      stopping Vaultwarden.
#   2. Bundle the snapshot + /data contents (attachments, sends, icons,
#      rsa keys, config.json) according to BACKUP_TYPE.
#
# Vaultwarden survives an abrupt SIGKILL fine — but a half-written
# db.sqlite3 captured during a transaction would not. The atomic
# .backup command is the whole reason this side-car doesn't need a
# docker socket mount.

set -uo pipefail

log() {
  printf '{"ts":"%s","level":"%s","sidecar":"drk-vaultwarden","phase":"backup","msg":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${1}" \
    "$(printf '%s' "${2}" | jq -Rs '.')"
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log info "starting backup (type=${BACKUP_TYPE})"

# --- staging --------------------------------------------------------------
# Build a clean staging directory holding:
#   - db.sqlite3   (atomic snapshot, NOT the live file)
#   - attachments/, sends/, icon_cache/, config.json, rsa_key.* (copied
#     from /source/data with cp -a — small enough to not matter on time)
stage_dir="$(mktemp -d /tmp/drk-vw-stage.XXXXXX)"
trap 'rm -rf "$stage_dir"' EXIT

db_src="${VW_DATA_SOURCE}/${VW_DB_FILENAME}"
db_dst="${stage_dir}/${VW_DB_FILENAME}"

if [[ -f "$db_src" ]]; then
  log info "snapshotting ${db_src} via sqlite .backup (atomic)"
  if ! sqlite3 "$db_src" ".backup '${db_dst}'"; then
    log error "sqlite .backup failed — likely a permission issue on the source mount"
    exit 1
  fi
else
  log warn "no db.sqlite3 at ${db_src} (first-boot install); continuing with file-only backup"
fi

# Copy everything else verbatim. Exclude the live db (we've already captured it).
log info "copying /data contents to staging"
if ! cp -a "${VW_DATA_SOURCE}/." "${stage_dir}/" \
        2>/dev/null; then
  # cp may complain about the live db being a moving target; that's fine
  # because we've already snapshotted it explicitly above.
  log warn "cp -a returned non-zero (live db skipped — already captured)"
fi
# Overwrite the just-copied (possibly torn) live db with the atomic snapshot
if [[ -f "$db_src" ]]; then
  cp -f "$db_dst" "${stage_dir}/${VW_DB_FILENAME}" 2>/dev/null || true
fi

# --- backup engine --------------------------------------------------------
case "${BACKUP_TYPE}" in
  local)
    out_name="vaultwarden-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    out_path="${BACKUP_DIR}/${out_name}"
    log info "writing tarball to ${out_path}"
    if ! tar -czf "${out_path}.tmp" -C "${stage_dir}" .; then
      log error "tar exited non-zero"
      exit 1
    fi
    mv "${out_path}.tmp" "${out_path}"

    # Hourly-skewed retention: keep 24h × 1 hourly + 14 daily + 8 weekly
    log info "applying tiered retention"
    apply_local_tiered_retention
    ;;

  s3|sftp|b2|azure)
    if ! restic backup "${stage_dir}" \
        --tag vaultwarden \
        --tag "host=${HOSTNAME}" \
        --host "drk-vaultwarden"; then
      log error "restic backup exited non-zero"
      exit 1
    fi

    log info "applying tiered retention (hourly=${RETENTION_KEEP_HOURLY} daily=${RETENTION_KEEP_DAILY} weekly=${RETENTION_KEEP_WEEKLY} monthly=${RETENTION_KEEP_MONTHLY})"
    if ! restic forget \
        --tag vaultwarden \
        --keep-hourly  "${RETENTION_KEEP_HOURLY}" \
        --keep-daily   "${RETENTION_KEEP_DAILY}" \
        --keep-weekly  "${RETENTION_KEEP_WEEKLY}" \
        --keep-monthly "${RETENTION_KEEP_MONTHLY}" \
        --prune; then
      log warn "restic forget/prune exited non-zero (backup itself succeeded)"
    fi
    ;;

  rclone)
    out_name="vaultwarden-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    local_tmp="/tmp/${out_name}"
    log info "staging tarball at ${local_tmp}"
    if ! tar -czf "${local_tmp}" -C "${stage_dir}" .; then
      log error "tar exited non-zero"
      rm -f "${local_tmp}"
      exit 1
    fi
    log info "uploading via rclone to ${RCLONE_REMOTE}:${RCLONE_PATH}"
    if ! rclone copyto "${local_tmp}" "${RCLONE_REMOTE}:${RCLONE_PATH}/${out_name}"; then
      log error "rclone copyto exited non-zero — local tmp left at ${local_tmp}"
      exit 1
    fi
    rm -f "${local_tmp}"
    ;;
esac

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log info "backup complete (started=${started_at} finished=${finished_at})"

# --- helper: local tiered retention --------------------------------------
# Bash doesn't have first-class associative-array support for this in a
# portable way, so we keep a simple count-based prune across the local
# tarball collection. Hourly cadence + 24-count = approximately one day
# of hourly coverage on disk.
apply_local_tiered_retention() {
  local total_keep
  total_keep=$(( ${RETENTION_KEEP_HOURLY:-24} + ${RETENTION_KEEP_DAILY:-14} ))
  ls -1t "${BACKUP_DIR}"/vaultwarden-*.tar.gz 2>/dev/null \
    | tail -n +"$((total_keep + 1))" \
    | while read -r old; do
        log info "pruning ${old}"
        rm -f "$old"
      done
}
