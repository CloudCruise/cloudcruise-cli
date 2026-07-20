---
name: run-investigate
description: Investigate a completed CloudCruise run (the MANDATORY companion to queue-run) by digesting its video, per-node debug snapshots, and errors, then grading the run against the plan/todos/ADRs — returns a compact verdict + recommendations only. Forked child of builder-drive; eats the big artifacts so the orchestrator's context stays clean. Never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# run-investigate — grade a real run against the plan

You are a **fork** dispatched by `builder-drive` immediately after every `queue-run` — from the
orchestrator's view the two are **one composite verb**. You digest the run's heavy artifacts
(video, per-node debug snapshots, error surfaces), grade the run **against the plan** (not against
the original video — plan-to-video, since you don't have the Loom), and **return a compact
paragraph**: a verdict + recommendations. You are the richest context source for the autonomous
loop, so be concrete. You **recommend**; only the orchestrator writes `todos.md`.

CLI command syntax lives in `/cloudcruise`. This skill is method only.

## Arguments contract

`$ARGUMENTS` gives you: `sessionId` (the run to investigate), `workflowId`, `statePaths` (absolute
paths to `todos.md`, ADR dir, `constraint-spec.md`, the plan with **per-section visual anchors +
the expected node list + enumerated conditional branches**, the audit log), and a `scratchDir` for
frames. Read the plan artifacts — the **visual anchors are your frame-registration key** and the
branch list is your reachability checklist.

## Step 1 — pull the run, pick the mode (don't pull it into context raw)

```bash
cloudcruise run get "$SID" > "$scratchDir/run.json"      # can be large — to a file, always
```

Parse from the file: `status`, `errors[]` (message, node_id, full_url, error_id), `workflow_errors[]`
(llm_error_category, llm_error_description), `screenshot_urls[]` (each with node_id, `.timestamp`,
`.error_screenshot`), `video_urls[]` (each `.signed_screen_recording_url` + `.timestamp`),
`output_data`, `session_retries`, `was_recovered`.

- `status: execution.success` → **GREEN mode** (completeness/correctness grading).
- `status: execution.failed | execution.stopped` → **RED mode** (diagnosis), then still run the
  GREEN completeness pass on the portion that executed.

The **executed-node spine** is `screenshot_urls[]` in `.timestamp` order — because `queue-run` is
always `--debug`, every node that ran emitted one snapshot (page state as the node *starts*, i.e.
the post-action state of the previous node). That ordered node_id list is what you align frames and
the plan against.

## Step 2 (GREEN) — completeness & correctness vs the plan

Sample the whole run and register it against the plan by **node-execution order** (no per-node
video timestamps yet — see the note at the bottom):

```bash
# use the last/longest video segment for a clean full run
bash scripts/green_frames.sh "<video_url>" "$scratchDir/green" 0.5
```

Read `g_0001 → g_N` in sequence; register each frame against the next expected plan section via its
**visual anchor**. Then grade:

- **Every plan section has nodes** — cross the executed-node spine + the workflow graph against the
  plan's section→node expectations. A plan section with no corresponding nodes = a gap.
- **Every conditional branch is reachable** — for each enumerated branch in the plan, confirm the
  graph has both arms and (for the input this run used) the taken arm matches intent. Flag branches
  the graph can never reach.
- **The run video is consistent with the plan sections** — the on-screen sequence matches the
  intended flow; no section silently skipped, no wrong-page detour.
- **Green-but-incomplete** — a section that ran green but is still a **scaffold** (a delay-node
  marker, or synthetic run-input data standing in for real work). This is the key green failure
  mode: the machine is green, the work isn't done. → recommend the orchestrator **reopen that
  todo**.

Spot-check claims against a couple of debug snapshots (`cloudcruise run snapshots "$SID"
<node_id>`) or a frame when a section's correctness is in doubt — don't trust green status alone
(a `was_recovered: true` run can be green while writing untrustworthy data).

## Step 2 (RED) — diagnosis vs the plan

**Video is ground truth; the error screenshot is a weak, often-wrong hint** (captured after the
failure, showing the symptom; the cause is almost always upstream). Select the right video segment
and extract the error region:

```bash
# REQUEUED runs have MULTIPLE video_urls — pick the segment whose timestamp is the smallest
# one >= the last error-screenshot timestamp (NOT video_urls[0]); math done for you here:
python3 - "$SID" <<'PY'
import json,subprocess,sys
from datetime import datetime
def iso(s): return datetime.fromisoformat(s.replace("Z","+00:00"))
d=json.loads(subprocess.check_output(["cloudcruise","run","get",sys.argv[1]]))
ets=[s for s in d["screenshot_urls"] if s.get("error_screenshot")][-1]["timestamp"]
segs=sorted(d["video_urls"], key=lambda v:v["timestamp"])
v=next((s for s in segs if iso(s["timestamp"])>=iso(ets)), segs[-1])
print(v["signed_screen_recording_url"]); print(v["timestamp"]); print(ets)
PY
# feed the 3 printed lines as url / video_ts / error_ts:
bash scripts/error_frames.sh "<url>" "$scratchDir/err" "<video_ts>" "<error_ts>"
```

Read `err_*` highest-number-first (the failure), then walk down and into `ctx_*` backwards to find
the **upstream** action that caused it (a not-yet-rendered element clicked, a skipped sibling that
left the page in the wrong place, a value cleared two nodes back). Only drop to `run snapshots
<sid> <node_id>` for exact selector/attribute HTML the video can't show. If the script's printed
gap is `≫ 45s`, XPath recovery flailed after the failure — re-anchor on the *first* error frame of
the failing node_id.

Classify the failure enough to recommend an action:
- **transient / race / site** (`execution.stopped` ~2min, element-not-ready, `SERVICE_UNAVAILABLE`,
  same value passed elsewhere and passed) → recommend **retry** (one re-run confirms a flake).
- **genuinely too hard right now** (ambiguous UI the builder can't resolve, a section that needs a
  human) → recommend **scaffold** (mark the todo blocked with the rich description) or **escalate**.
- **fixable graph/selector defect** → recommend a targeted `fix` todo (name the node_id + the
  upstream cause), so the orchestrator re-dispatches `work`.

## Step 3 — return contract

Append one audit line (`timestamp | investigate | session=<sid> mode=<green|red> …`), then **return
a compact paragraph** — the only thing that survives this fork:

- **verdict** — `green-complete` / `green-incomplete` / `red`.
- **coverage** — per plan section: has-nodes? ran? scaffold-or-real? Which sections/branches are
  gaps or unreachable.
- **diagnosis** (red) — the upstream root cause in one or two sentences, the failing node_id, and
  the frame/snapshot evidence pointer.
- **recommendations** — the exact todo actions for the orchestrator: reopen todo N (incomplete
  scaffold), add a `fix` todo for node X (cause Y), retry the run, mark blocked, or escalate. Be
  specific; the orchestrator acts on these verbatim.

Keep it to a paragraph or two. Frames and `run.json` stay on disk; the return is the decision.

## Notes

- **Grade plan-to-video, not video-to-video.** You compare the run to the *intended plan* (todos +
  ADRs + visual anchors), not to the source Loom (you don't have it here).
- **No per-node video timestamps yet → order-based alignment.** The day per-node timestamps ship,
  swap the uniform GREEN sweep for timestamp-indexed extraction. **Worth flagging:** because
  `queue-run` is always `--debug`, `screenshot_urls[].timestamp` already gives a per-node time spine
  you can use to index the video today — the SKILL keeps order-based alignment as primary per the
  design, but the debug-snapshot spine is a viable near-term upgrade if the orchestrator wants
  tighter registration.
- **Fork discipline** — never let full `run.json`, frame dumps, or `builder messages` into a return.
  Read them here, return the paragraph.
