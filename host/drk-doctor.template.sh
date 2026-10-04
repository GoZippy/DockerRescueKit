#!/bin/sh
# Docker Rescue Kit — offline daemon diagnosis (macOS / Linux).
#
# TEMPLATE. The shipped script is host/generated/drk-doctor.sh, produced by
# tools/gen-catalogue.js, which replaces the #__DRK_CATALOGUE__ marker below with
# the pattern table generated from packages/shared/src/dockerFatalErrors.ts.
# Editing the generated file is pointless — edit this template or the catalogue.
#
# Installed on the host by Docker Desktop when the DRK extension is installed
# (see metadata.json `host.binaries`). Runs with no daemon, no API key, and no
# running DRK — deliberately, because when the Docker daemon is down every
# containerised component is down with it, including the DRK extension itself.
#
# Docker Desktop reports the wrong error for daemon startup failures: it shows
# whichever non-fatal message the daemon logged most recently, not the fatal
# one. The truth lives in the VM-side init log, which this script reads.
#
# Exit codes:  0 nothing fatal found · 2 fatal error found · 1 could not run
#
# POSIX sh on purpose — macOS still ships bash 3.2 and this must not depend on
# a modern bash being present.

set -u

LOG_PATH=""
LOG_EXPLICIT=0
JSON_OUT=0

#__DRK_CATALOGUE__

usage() {
    cat <<'EOF'
drk-doctor — offline Docker daemon diagnosis

Usage: drk-doctor.sh [--log <path>] [--json]

  --log <path>  Read a specific init.log instead of auto-detecting.
  --json        Emit machine-readable output.

Repair of a corrupted network store is currently Windows/WSL2 only; on macOS and
Linux this command diagnoses but does not repair. See docs/DAEMON_WONT_START.md.
EOF
}

# `shift 2` aborts the script under dash when only one argument remains, so
# shift defensively.
while [ $# -gt 0 ]; do
    case "$1" in
        --log)
            LOG_PATH="${2:-}"
            LOG_EXPLICIT=1
            shift
            [ $# -gt 0 ] && shift
            ;;
        --json) JSON_OUT=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
done

# ---- locate the init log ---------------------------------------------------

if [ -z "$LOG_PATH" ]; then
    case "$(uname -s)" in
        Darwin) LOG_PATH="$HOME/Library/Containers/com.docker.docker/Data/log/vm/init.log" ;;
        *)      LOG_PATH="$HOME/.docker/desktop/log/vm/init.log" ;;
    esac
fi

if [ ! -r "$LOG_PATH" ]; then
    printf 'error: cannot read Docker VM init log at %s\n' "$LOG_PATH" >&2
    if [ "$LOG_EXPLICIT" -eq 1 ]; then
        printf 'The path was supplied with --log. Check it exists and is readable.\n' >&2
    else
        printf 'Pass --log <path> if Docker Desktop is installed somewhere non-standard.\n' >&2
    fi
    exit 1
fi

# Bounded: only the tail matters, and these logs get large. Kept in step with
# the TypeScript and PowerShell implementations so all three see the same window.
TAIL_LINES=4000
LOG_TAIL=$(tail -n "$TAIL_LINES" "$LOG_PATH" 2>/dev/null) || {
    printf 'error: failed to read %s\n' "$LOG_PATH" >&2
    exit 1
}

# ---- match ----------------------------------------------------------------

FOUND=0
CODE=""
TITLE=""
ADVICE=""
HIT=""
WHEN=""

# Catalogue order is significant: specific patterns precede the generic
# `failed to start daemon:` fallback, and the FIRST match wins — the specific and
# generic patterns match the same log line, so without the break the user is told
# both "here is your exact problem" and "this is not in the catalogue yet".
#
# `set -f` disables pathname expansion: records contain *, ? and [...] which the
# shell would otherwise try to glob.
set -f
OLD_IFS=$IFS
IFS='
'
for RECORD in $DRK_FATAL_PATTERNS; do
    CODE=$(printf '%s' "$RECORD" | cut -f1)
    ERE=$(printf '%s' "$RECORD" | cut -f2)
    TITLE=$(printf '%s' "$RECORD" | cut -f3)
    ADVICE=$(printf '%s' "$RECORD" | cut -f4)

    # -i because every catalogue pattern is case-insensitive; the generator
    # asserts that invariant rather than encoding a per-record flag.
    HIT=$(printf '%s\n' "$LOG_TAIL" | grep -Ei "$ERE" | tail -n 1)
    if [ -n "$HIT" ]; then
        FOUND=1
        WHEN=$(printf '%s' "$HIT" | sed -n 's/.*"time":"\([^"]*\)".*/\1/p')
        break
    fi
done
IFS=$OLD_IFS
set +f

# A completed loop leaves CODE holding the LAST record's code. Clear it so the
# JSON branch cannot report a finding that was never made.
if [ "$FOUND" -eq 0 ]; then
    CODE=""
fi

# ---- decoys ---------------------------------------------------------------

DECOY_OUTPUT=""
if [ "$FOUND" -eq 1 ]; then
    set -f
    OLD_IFS=$IFS
    IFS='
'
    for RECORD in $DRK_DECOY_PATTERNS; do
        DERE=$(printf '%s' "$RECORD" | cut -f1)
        DNOTE=$(printf '%s' "$RECORD" | cut -f2)
        if printf '%s\n' "$LOG_TAIL" | grep -Eiq "$DERE"; then
            DECOY_OUTPUT="$DECOY_OUTPUT
  - $DNOTE"
        fi
    done
    IFS=$OLD_IFS
    set +f
fi

# ---- report ---------------------------------------------------------------

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ "$JSON_OUT" -eq 1 ]; then
    printf '{"logPath":"%s","fatalFound":%s,"code":"%s"}\n' \
        "$(json_escape "$LOG_PATH")" \
        "$([ "$FOUND" -eq 1 ] && echo true || echo false)" \
        "$(json_escape "$CODE")"
    [ "$FOUND" -eq 1 ] && exit 2
    exit 0
fi

printf '\ndrk doctor — offline Docker daemon diagnosis\n'
printf 'log: %s\n\n' "$LOG_PATH"

if [ "$FOUND" -eq 0 ]; then
    printf 'No fatal daemon errors found in the last %s lines.\n' "$TAIL_LINES"
    printf 'If Docker still will not start, check whether the log has any entries newer\n'
    printf 'than your last start attempt — if not, the VM is not booting at all.\n\n'
    exit 0
fi

printf '[CRITICAL] %s: %s\n' "$CODE" "$TITLE"
printf '  seen: %s\n' "${WHEN:-unknown}"
printf '  log:  %s\n' "$(printf '%s' "$HIT" | cut -c1-400)"
printf '  next: %s\n\n' "$ADVICE"

if [ -n "$DECOY_OUTPUT" ]; then
    printf 'If Docker Desktop is showing you one of these messages as the cause, it is\n'
    printf 'not the cause — they appear on healthy starts too:%s\n\n' "$DECOY_OUTPUT"
fi

printf 'Full detail: https://github.com/GoZippy/DockerRescueKit/blob/main/docs/DAEMON_WONT_START.md\n\n'
exit 2
