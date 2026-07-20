---
name: queue-run
description: Trigger ONE real CloudCruise run (always --debug) against the saved workflow, poll it to terminal, and collect artifact POINTERS without pulling the large artifacts into context. Forked child of builder-drive; paired one-to-one with run-investigate, which grades the run it queued. Never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# queue-run — fire a real run, return pointers

You are a **fork** dispatched by `builder-drive` to trigger **one real backend run** of the saved
workflow and wait for it to finish. You are thin: start the run, poll to terminal, write a small
pointer file, and **return a one-paragraph summary** (session_id + terminal status + pointer-file
path). You do **not** diagnose — that is `run-investigate`, which the orchestrator invokes next on
your session_id. From the orchestrator's view you two are one composite verb.

CLI syntax lives in `/cloudcruise`. Method only here.

## Preconditions (the orchestrator owns these — verify, don't assume)

- **The workflow is SAVED.** A real run executes the *saved* workflow, not the live builder graph.
  The orchestrator runs `builder save` before dispatching you. If unsure, say so in your return
  rather than run a stale version.
- **Workspace is active** (`cloudcruise auth status` / `workspaces show`). A missing workspace
  fails the run.
- **The credential key is in the input.** The run endpoint requires a top-level property named
  after the workflow's `vault_schema` **alias** (e.g. `USER`), whose value is the vault row's bare
  **`permissioned_user_id`** (resolve via `cloudcruise vault list`; the row's domain must match the
  workflow). A missing one gives `400 must have required property '<alias>'`. The orchestrator
  passes this in the input; if the start 400s on a missing/mismatched credential, return that
  verbatim — don't guess a value.

## Arguments contract

`$ARGUMENTS`: `workflowId`, `input` (the full run-input JSON — includes the credential key and any
**plausible synthetic values for scaffolded sections**, supplied via run inputs, never graph
mutations), `statePaths` (audit log), `scratchDir` (where to write the pointer file), and optional
`maxSeconds`/`intervalSeconds` poll tuning.

## Procedure

```bash
# 1. Start the run — ALWAYS --debug (per-node snapshots on every node). Returns {session_id}.
cloudcruise run start "$WF" --debug --input "$INPUT" > "$scratchDir/run_start.json"
SID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["session_id"])' "$scratchDir/run_start.json")

# 2. Poll to terminal (self-contained loop; execution.success|failed|stopped are terminal).
STATUS=$(bash scripts/poll_run.sh "$SID" "${MAXSECONDS:-1800}" "${INTERVALSECONDS:-15}")

# 3. Collect POINTERS only — never pull the full run get into context.
cloudcruise run get "$SID" > "$scratchDir/run.json"
python3 - "$scratchDir/run.json" "$scratchDir/pointers.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
ptr={
  "session_id": d.get("session_id") or d.get("id"),
  "status": d.get("status"),
  "errors_n": len(d.get("errors") or []),
  "workflow_errors_n": len(d.get("workflow_errors") or []),
  "screenshots_n": len(d.get("screenshot_urls") or []),
  "video_segments_n": len(d.get("video_urls") or []),
  "was_recovered": d.get("was_recovered"),
  "session_retries": d.get("session_retries"),
  "run_json": sys.argv[1],
}
json.dump(ptr, open(sys.argv[2],"w"), indent=2)
print(json.dumps(ptr))
PY
```

If `run start` errors, surface the exit code + stderr envelope verbatim (bad workspace/credential/
schema are common and the orchestrator needs the exact reason). If `poll_run.sh` prints
`TIMEOUT:<status>`, report it — the run may still be running; the orchestrator decides whether to
`run interrupt` or wait longer.

## Return contract

Append one audit line (`timestamp | queue-run | session=<sid> status=<terminal> debug=true`), then
**return a one-paragraph summary**: the `session_id`, the terminal status, the pointer counts
(errors / screenshots / video segments), the pointer-file path (`$scratchDir/pointers.json`) and
the `run.json` path. That's it — the orchestrator hands your `session_id` + `scratchDir` straight to
`run-investigate`. Do not read frames, do not diagnose, do not pull `run.json` content into your
return.

## Notes

- **Big artifacts stay on disk.** `run.json` (and anything downstream) can be ~1MB — you redirect it
  to a file and only surface counts. This is why you're a fork.
- **One run at a time.** builder-drive queues a single run per loop iteration, so cross-run
  collision (the payload-sweep distinct-date/serial concern) doesn't apply here.
- **Always `--debug`** — locked decision; per-node snapshots are what make `run-investigate`'s
  node-order alignment and red-mode diagnosis possible.
