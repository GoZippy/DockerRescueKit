#!/usr/bin/env bash
# drk-vaultwarden entrypoint — wires env into a cron loop.
#
# Mirrors the structure of sidecars/plex/entrypoint.sh but with two key
# differences:
#   1. No docker socket requirement (atomic SQLite .backup means no stop)
#   2. Default schedule is hourly, not daily

set -euo pipefail

log() {
  printf '{"ts":"%s","level":"%s","sidecar":"drk-vaultwarden","msg":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${1}" \
    "$(printf '%s' "${2}" | jq -Rs '.')"
}

die() {
  log error "${1}"
  exit 1
}

# --- env validation -------------------------------------------------------
[[ -n "${BACKUP_DIR:-}" ]]          || die "BACKUP_DIR is required"
[[ -n "${BACKUP_SCHEDULE:-}" ]]     || die "BACKUP_SCHEDULE is required (cron expression)"
[[ -d "${VW_DATA_SOURCE}" ]]        || die "VW_DATA_SOURCE ${VW_DATA_SOURCE} not mounted (expected the Vaultwarden /data volume)"
[[ -f "${VW_DATA_SOURCE}/${VW_DB_FILENAME}" ]] \
  || log warn "${VW_DATA_SOURCE}/${VW_DB_FILENAME} not found yet (first-boot Vaultwarden creates it on first request)"
[[ -d "${BACKUP_DIR}" ]]            || die "BACKUP_DIR ${BACKUP_DIR} not mounted"

case "${BACKUP_TYPE}" in
  local|s3|sftp|rclone|b2|azure) : ;;
  *) die "BACKUP_TYPE must be one of: local, s3, sftp, rclone, b2, azure" ;;
esac

if [[ "${BACKUP_TYPE}" != "local" ]]; then
  [[ -n "${RESTIC_PASSWORD:-}" ]] \
    || die "RESTIC_PASSWORD is required for BACKUP_TYPE=${BACKUP_TYPE}"
fi

case "${BACKUP_TYPE}" in
  s3)     [[ -n "${RESTIC_REPOSITORY:-}" ]] || die "RESTIC_REPOSITORY is required for s3" ;;
  sftp)   [[ -n "${RESTIC_REPOSITORY:-}" ]] || die "RESTIC_REPOSITORY is required for sftp" ;;
  b2)     [[ -n "${RESTIC_REPOSITORY:-}" && -n "${B2_ACCOUNT_ID:-}" && -n "${B2_ACCOUNT_KEY:-}" ]] \
          || die "BACKUP_TYPE=b2 needs RESTIC_REPOSITORY, B2_ACCOUNT_ID, B2_ACCOUNT_KEY" ;;
  azure)  [[ -n "${RESTIC_REPOSITORY:-}" && -n "${AZURE_ACCOUNT_NAME:-}" && -n "${AZURE_ACCOUNT_KEY:-}" ]] \
          || die "BACKUP_TYPE=azure needs RESTIC_REPOSITORY, AZURE_ACCOUNT_NAME, AZURE_ACCOUNT_KEY" ;;
  rclone) [[ -n "${RCLONE_REMOTE:-}" && -n "${RCLONE_PATH:-}" ]] \
          || die "BACKUP_TYPE=rclone needs RCLONE_REMOTE and RCLONE_PATH" ;;
esac

log info "drk-vaultwarden ${DRK_SIDECAR_VERSION} starting (backup_type=${BACKUP_TYPE} schedule='${BACKUP_SCHEDULE}' tz=${TZ})"

# --- restic repo init (idempotent) ----------------------------------------
if [[ "${BACKUP_TYPE}" != "local" && "${BACKUP_TYPE}" != "rclone" ]]; then
  if ! restic snapshots --json >/dev/null 2>&1; then
    log info "initialising new restic repository at ${RESTIC_REPOSITORY}"
    restic init || die "restic init failed"
  else
    log info "restic repository already initialised"
  fi
fi

# --- optional first-run backup --------------------------------------------
if [[ "${BACKUP_ON_START}" == "true" ]]; then
  log info "BACKUP_ON_START=true — running an immediate backup before scheduling"
  /usr/local/bin/run-backup.sh || log warn "initial backup returned non-zero (will retry on schedule)"
fi

# --- cron loop ------------------------------------------------------------
# Same minimal in-process cron as drk-plex — see sidecars/plex/entrypoint.sh
# for the original. Repeated here so each side-car stays self-contained.
log info "entering schedule loop"
last_run_min=""

cron_match() {
  local field="$1" actual="$2"
  if [[ "$field" == "*" ]]; then return 0; fi
  if [[ "$field" =~ ^\*/([0-9]+)$ ]]; then
    local step="${BASH_REMATCH[1]}"
    (( actual % step == 0 )) && return 0 || return 1
  fi
  IFS=',' read -ra parts <<< "$field"
  for p in "${parts[@]}"; do
    if [[ "$p" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      (( actual >= ${BASH_REMATCH[1]} && actual <= ${BASH_REMATCH[2]} )) && return 0
    elif [[ "$p" =~ ^[0-9]+$ ]]; then
      (( actual == p )) && return 0
    fi
  done
  return 1
}

trap 'log info "received SIGTERM, exiting"; exit 0' SIGTERM SIGINT

while true; do
  sleep $(( 60 - $(date +%S) ))

  now_min=$(date +"%Y-%m-%dT%H:%M")
  [[ "$now_min" == "$last_run_min" ]] && continue

  read -r mn hr dm mo dw <<< "$BACKUP_SCHEDULE"
  cur_mn=$(date +%-M); cur_hr=$(date +%-H); cur_dm=$(date +%-d); cur_mo=$(date +%-m); cur_dw=$(date +%w)

  if cron_match "$mn" "$cur_mn" \
  && cron_match "$hr" "$cur_hr" \
  && cron_match "$dm" "$cur_dm" \
  && cron_match "$mo" "$cur_mo" \
  && cron_match "$dw" "$cur_dw"; then
    last_run_min="$now_min"
    log info "schedule matched at ${now_min} — running backup"
    /usr/local/bin/run-backup.sh \
      && log info "backup completed successfully" \
      || log error "backup returned non-zero exit code"
  fi
done
