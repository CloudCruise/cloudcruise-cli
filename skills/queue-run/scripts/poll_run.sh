#!/usr/bin/env bash
# Poll a single run to terminal. Self-contained loop (one Bash call that blocks until done),
# so it is NOT a bare foreground `sleep`.
#
# Usage: poll_run.sh <session_id> [max_seconds=1800] [interval_seconds=15]
# Prints one line: the terminal status, or TIMEOUT:<last-status>.
#   Terminal: execution.success | execution.failed | execution.stopped
#   In-flight: execution.start
set -euo pipefail
SID="${1:?session_id}"; MAX="${2:-1800}"; INT="${3:-15}"; elapsed=0
while :; do
  st=$(cloudcruise run get "$SID" 2>/dev/null \
       | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo "?")
  case "$st" in
    execution.success|execution.failed|execution.stopped) echo "$st"; exit 0;;
  esac
  if [ "$elapsed" -ge "$MAX" ]; then echo "TIMEOUT:$st"; exit 0; fi
  sleep "$INT"; elapsed=$((elapsed+INT))
done
