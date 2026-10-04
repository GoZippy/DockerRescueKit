#!/bin/sh
# SUPERSEDED — do not ship or edit this file.
#
# The doctor script is now generated: edit host/drk-doctor.template.sh (logic) or
# packages/shared/src/dockerFatalErrors.ts (patterns), then run:
#
#   npm run gen:catalogue
#
# which writes the self-contained host/generated/drk-doctor.sh that metadata.json
# and the Dockerfile actually reference. This stub exists only so a stale path
# fails loudly instead of shipping a version with no pattern table.
#
# DELETE ME once you have confirmed nothing references host/drk-doctor.sh.

printf 'drk-doctor: this is the un-generated stub.\n' >&2
printf 'Run `npm run gen:catalogue` and use host/generated/drk-doctor.sh instead.\n' >&2
exit 1
