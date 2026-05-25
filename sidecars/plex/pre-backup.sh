#!/usr/bin/env bash
# Pre-backup quiesce for Plex.
#   1. (optional) Clear the transcoder cache — saves GB on every backup
#   2. (optional) Stop the Plex container so the SQLite databases are
#      flushed to disk in a consistent state
#
# Both steps are individually configurable via env. Each step's failure
# is logged but does not abort the backup — partial quiesce > no backup.

set -uo pipefail

log() {
  printf '{"ts":"%s","level":"%s","sidecar":"drk-plex","phase":"pre","msg":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${1}" \
    "$(printf '%s' "${2}" | jq -Rs '.')"
}

# Clear the transcoder cache. Plex regenerates it on demand; deleting it
# pre-backup saves dozens of GB from every archive without harming function.
if [[ "${CLEAR_TRANSCODE_CACHE}" == "true" ]]; then
  for candidate in \
    "${PLEX_CONFIG_SOURCE}/Library/Application Support/Plex Media Server/Cache/Transcode" \
    "${PLEX_CONFIG_SOURCE}/Plex Media Server/Cache/Transcode"
  do
    if [[ -d "$candidate" ]]; then
      log info "clearing transcoder cache at ${candidate}"
      # Use find rather than rm -rf so we never traverse out of the cache dir.
      find "$candidate" -mindepth 1 -delete 2>/dev/null \
        || log warn "transcoder cache delete returned non-zero (continuing)"
      break
    fi
  done
fi

# Stop Plex. We use docker stop with a generous --time so the in-flight
# transcoder sessions get a chance to exit cleanly, then restart after the
# backup in the post-backup hook (called from run-backup.sh).
if [[ "${STOP_PLEX_BEFORE_BACKUP}" == "true" ]]; then
  if docker inspect "${PLEX_CONTAINER}" >/dev/null 2>&1; then
    log info "stopping ${PLEX_CONTAINER} before backup"
    docker stop --time 30 "${PLEX_CONTAINER}" \
      || log warn "docker stop ${PLEX_CONTAINER} returned non-zero (continuing — backup may be inconsistent)"
  else
    log warn "container ${PLEX_CONTAINER} not found via docker inspect; skipping stop"
  fi
fi
