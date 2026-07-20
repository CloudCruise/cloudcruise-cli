#!/usr/bin/env bash
# Poll a set of runs and print a status table.
#
# Usage:
#   ./poll_all.sh "SID1:full SID2:empty SID3:partial_a SID4:partial_b"
# or from a file of "session_id:label" lines (one per line):
#   ./poll_all.sh "$(cat run_sessions.txt)"
#
# Terminal statuses: execution.success | execution.failed | execution.stopped
# In-flight:         execution.start (queued or running)
set -euo pipefail
SESSIONS="${1:?usage: poll_all.sh \"SID:label SID:label ...\"}"

for pair in $SESSIONS; do
  s="${pair%%:*}"; label="${pair#*:}"
  cloudcruise run get "$s" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
errs=d.get('errors') or []
e=errs[0] if errs else {}
cat=''
we=d.get('workflow_errors') or []
if we: cat=we[0].get('llm_error_category','') or ''
print(f\"$label|${s:0:8}|{d.get('status','?')}|{cat}|{(e.get('message') or '')[:120]}\")
" || echo "$label|${s:0:8}|ERR|-|run get failed"
done | column -t -s'|'
