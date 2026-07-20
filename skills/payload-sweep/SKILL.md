---
name: payload-sweep
description: Stress-test a CloudCruise workflow for MECHANICAL correctness by generating synthetic input payloads from its input_schema (full / empty / partial_a / partial_b, plus a hand-built max), triggering one run per tier, polling them to terminal, then classifying each failure by who owns the fix — payload bug, schema-too-strict/incoherent, workflow null-unsafe (direct fix), workflow mechanical bug like node-ordering/bad-XPath/element-not-ready (needs a human to drive a builder session), or site/extension. Explicitly out of scope: semantic correctness (single-input-vs-should-loop, progress not saved) — that's caught by manual inspection of successful runs, not this sweep. Use when the user wants to validate a workflow runs cleanly against fake/synthetic data end-to-end, not fix one known failure.
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob
---

# payload-sweep — schema-driven workflow stress testing

Generate synthetic payloads from a workflow's `input_schema`, run one per coverage
tier, poll them to terminal, and classify each failure into an **actionable owner**:
the payload, the schema, the workflow graph, or the site/extension. The goal is to
prove a workflow is null-safe and its schema coherent *before* real traffic hits the
long-tail of sparse/partial inputs.

### Scope: mechanical correctness, not semantic

This skill establishes that a workflow runs **mechanically** — every node fires in the
right order, every selector resolves, no null blows up a transform, no field is
rejected at the door. A run going green here means the machine works.

It does **not** establish **semantic** correctness — that the workflow does the *right*
thing. Semantic failures don't throw: the workflow is wired for a single input when it
should loop over a collection; it clicks through paginated results without ever saving
progress; it fills the wrong-but-valid field. These pass every tier in this sweep and
are only caught by **manual inspection of a successful run's output** against intent.
That inspection is a separate step, out of scope here — but a green sweep is the
precondition for it: verify the machine works, *then* verify it works on the right thing.

All CLI command syntax (`auth`, `workflows get`, `run start/get/snapshots`,
`vault list`, `workflows update`) lives in **`/cloudcruise`** — this skill is the
*method* layered on top; it does not re-document the CLI. Read `/cloudcruise` first
if you don't have the command surface loaded.

> **v1 — rough outline, honed across invocations.** The generator (`full`/`empty`/
> `partial_*`) and the classification decision-tree are solid. `max` is still a
> guided manual step, and the classification catalog grows every time we run this on
> a new workflow. When you learn something new, edit this file.

## The four phases

```
1. GENERATE   input_schema  ──▶  full / empty / partial_a / partial_b / max
2. QUEUE      one run per tier (distinct calendar date so runs don't collide)
3. POLL       run get until every session is terminal
4. CLASSIFY   each failure → payload | schema | workflow | site/extension → fix
```

---

## 1. Generate

Pull the workflow and run the generator. Values come from the **schema** (enum →
example → type default), never faker — so repros are deterministic.

```bash
cloudcruise workflows get <workflow_id> > workflow.json
python3 scripts/gen_payloads.py workflow.json --outdir ./sweep
# writes sweep/payloads.json + sweep/run_input_{full,empty,partial_a,partial_b}.json
# and prints a leaf-count sanity table (full=0% null, empty=100%, a≈40%, b≈60%)
```

### The tiers

| Tier | What it exercises | How it's built |
|---|---|---|
| **`full`** | happy path, every field valid | enum first-meaningful → `example` → type default; unconstrained free-text → `""`; one element per array |
| **`empty`** | every field null but full nesting depth present | all leaf scalars `null`; object-arrays keep one all-null skeleton row — **BUT** see caveat below |
| **`partial_a`** | realistic sparse input (~40% missing) | ~40% of leaves nulled, chosen by `md5(path)` — deterministic |
| **`partial_b`** | heavier sparse input (~60% missing) | ~60% nulled, different mask |
| **`max`** | schema ceiling + form contradictions | **hand-built**, not generated (below) |

**Why partials are the point:** null bugs are invisible in `full` (nothing null) and
`empty` (a STATIC bool on `""` throws safe and takes the false branch). They only fire
on a *mixed* payload — e.g. `{present: true, via: null}` drives a TRANSFORM into
`$trim(null)`, which is a **fatal `SERVER-E0002`**. Sweep the partials to find these.

> ⚠️ **empty's all-null skeleton row is an ARTIFACT for object-arrays wired to an
> "Add row" LOOP.** A real caller sends `null`/`[]` for an absent collection, not
> `[{all-null-row}]`. A properly-guarded loop (`{{$type(x)='array' ? x : []}}`) SKIPS on
> `null`/`[]` but IterATES ONCE on `[{null row}]` — then a STATIC selector built from the
> row's null field (`@data-user-type='{{current.discipline}}'` → `=''`) matches nothing
> and fails. That failure is the **generator's**, not the workflow's — don't log it as a
> null-unsafe bug. When empty fails inside an add-loop, null the whole object-array and
> re-run before classifying. (MyUnity Recert `0d70295b` frequencies loop, 2026-07-15.)

### Building `max` (manual, guided)

`max` is maximal coverage to surface enum gaps and form-level contradictions:
- every boolean `true`
- every multi-select array carrying **all** its enum options
- every free-text filled (use `example`, else a test sentence)
- one sub-row per object-array type (e.g. all 6 breath-sound rows)

`max` deliberately produces incoherent combos a single-select form can't express
(e.g. `no_problems_identified: true` **and** every problem checked) — those failures
are the signal that the schema needs an `if/then` guard (see Classify).

### Reusing old payloads — always drift-check first

If payloads already exist for this workflow, **diff old vs current `input_schema`
leaf-by-leaf** (added/removed keys, type/enum changes, `required` diffs) before reuse.
A workflow that gained top-level fields between versions will silently under-test.
When in doubt, regenerate from the current `workflow.json`.

---

## 2. Queue

**Setup (both are common footguns):**

```bash
cloudcruise auth status
cloudcruise auth workspace use <workspace_id>     # `use`, NOT `--set`
```

**Credential key.** The run endpoint requires a top-level property named after the
workflow's `vault_schema` **alias** (e.g. `USER`, `axxess_credentials`). A missing one
gives `400 must have required property '<alias>'`. Its value is the vault row's bare
**`permissioned_user_id`** — resolve via `cloudcruise vault list`, and:
- strip any spurious suffix off the id (real value is often an email),
- the vault row's **domain must match** the workflow or you get
  `Credentials for <id> and domain <d> (alias: X) not found`.

Add the key to each `run_input_*.json` before triggering.

**Avoid run-collision by data, not a flag.** There is no `--schedule`. For workflows
that write to a shared resource (a calendar visit, a patient record), give each tier a
**distinct date** (`task_date` + any `scheduled_calendar_*` fields) so the runs work
disjoint rows. Then fire all of them — the dispatcher queues them.

> ⚠️ **Distinct-date only disjoints PER-DATE records.** If the workflow edits a single
> **per-episode** record (a recert/SOC OASIS assessment opens the *same* `activityId`
> regardless of visit date), concurrent tiers collide on an optimistic-lock modal
> ("Conflicts detected") — and that modal **masks the tier's real error**, so every run
> looks like it died at the same node for the same reason. Tell-tale: all sessions'
> `full_url` share one `activityId`, and they fail at whichever node was mid-edit when
> the neighbor saved. Fix: run these tiers **strictly serially** (start → poll terminal →
> start next). Serial runs then fail at *different* nodes — that divergence is the real
> signal. (Confirmed on MyUnity Recert `0d70295b`, 2026-07-15.)

```bash
for k in full empty partial_a partial_b; do
  echo "=== $k ==="
  cloudcruise run start <workflow_id> --input "$(cat sweep/run_input_$k.json)" 2>&1 | head -c 400
done | tee sweep/run_sessions.txt
```

Fire-and-forget is the default; use `--wait --debug` only for a single reproduction
run (see `/cloudcruise` Error-Fix-Verify loop). **Map session→tier via the loop order +
the tee'd file** — record it, you'll need it in Classify.

---

## 3. Poll

```bash
# session_id:label pairs — build from sweep/run_sessions.txt
./scripts/poll_all.sh "SID_full:full SID_empty:empty SID_a:partial_a SID_b:partial_b"
```

**Terminal by `status`** — `execution.success | execution.failed | execution.stopped`
are done; `execution.start` is still queued/running. `end_reason` is often null; trust
`status`. Re-poll on demand until all rows are terminal (no fixed cadence needed for a
handful of runs; launch as background tasks for long ones).

Note the two text error surfaces on `run get`: the **`errors`** array (`message`, `node_id`,
`full_url`, `error_id`) and **`workflow_errors`** (`llm_error_category`,
`llm_error_description`) — check both, but they only name the *symptom* node. The real
diagnosis comes from the **session video** (`video_urls`), not these — see Classify §4.

---

## 4. Classify → actionable update

For each failure: `run get <sid>` → read `status`, `session_retries`, `was_recovered`,
then **watch the video around the error — the video is ground truth** (below). Assign an
**owner**:

#### Error analysis: the session video is ground truth, not the screenshot

The labeled **error screenshot is usually misleading** — it's captured a few hundred ms
*after* the failure, once the DOM is already in a derived/bad state, so it shows the
**symptom**. The **root cause is almost always upstream** (a skipped sibling that left the
scroll/page wrong, a value cleared two nodes back, a gate that should have fired). This
sweep hit that repeatedly: "select found no visible option" (cause: an upstream select was
skipped, so the page never scrolled there); "dropdown didn't open" (cause: the form
*disabled* it via skip-logic upstream). **Trust the video; treat the screenshot as a weak,
often-wrong hint.**

Each failed run's `run get` returns `video_urls[0].signed_screen_recording_url` (one
recording per session) plus a `.timestamp` (≈ recording finalize/end time), and
`screenshot_urls` where the error frames carry a precise `.timestamp`. Anchor on the
**error-screenshot timestamp** (reliable) — *not* freeze detection (a spinner may keep
animating; the freeze can land 10–30s past the real error). The recording ends shortly
after the error, so:

> `t_err = ffprobe_duration − (video.timestamp − last_error_screenshot.timestamp)`

The script does this math for you — pass it the two timestamps:

```bash
# pull the 3 values from run get, then extract:
python3 - "$SID" <<'PY'
import json,subprocess,sys
from datetime import datetime
def iso(s): return datetime.fromisoformat(s.replace("Z","+00:00"))
d=json.loads(subprocess.check_output(["cloudcruise","run","get",sys.argv[1]]))
ets=[s for s in d["screenshot_urls"] if s.get("error_screenshot")][-1]["timestamp"]
# REQUEUED runs have MULTIPLE video_urls (one per segment). Pick the segment whose
# timestamp is the smallest one >= the error ts (the recording that CONTAINS the error) —
# NOT video_urls[0]. (If the run wasn't requeued there's just one.)
segs=sorted(d["video_urls"], key=lambda v:v["timestamp"])
v=next((s for s in segs if iso(s["timestamp"])>=iso(ets)), segs[-1])
print(v["signed_screen_recording_url"]); print(v["timestamp"]); print(ets)
PY
# -> feed those 3 lines as url / video_ts / error_ts:
./scripts/error_video.sh "<url>" ./sweep/vid_<sid> "<video_ts>" "<error_ts>"
```
The script prints `gap (video_ts − error_ts)`; **if it's negative or > duration you grabbed
the wrong segment** (stale `[0]` on a requeued run) — reselect the segment just after the error.

Use the **last** error frame's timestamp normally — but if `gap (video.timestamp −
error_ts)` comes out **≫ 45s** (the script prints it), XPath recovery scrolled/retried for
minutes *after* the failure; anchor instead on the **first** error frame of the failing
`node_id` so the window lands on the clean failure state, not the recovery flailing.

It samples **one minute back** from `t_err`, denser as it approaches: `ctx_*`
(`t_err−60…−12` @0.3 fps — what it was *doing* before failing) and `err_*`
(`t_err−12…+3` @3 fps — tight on the failure). Everything after `t_err+3s` (the dead hang)
is dropped. **Read `err_*` highest-number-first (the failure), then walk down and into
`ctx_*` backwards to find the UPSTREAM action that caused it** (e.g. this sweep: an
`err_*` frame showed the browser still mid-page-load with a spinner while the workflow
clicked a link that hadn't rendered → the "not found" error was a page-not-ready race, not
a bad selector — invisible in the static error screenshot). Only drop to
`run snapshots <sid> <node_id>` for exact selector/attribute HTML the video can't show
(requires the run was `--debug`).

| Owner | Signature | Actionable fix |
|---|---|---|
| **Payload** | incoherent combo the form can't express — e.g. an exclusive sentinel (`"N/A"`, `"No problems identified"`) *alongside* real options in a multi-select; a `present:true` with a missed sibling flag → `INCORRECT_FORM_INPUTS` | fix the generator/`max` artifact — strip sentinels from mixed arrays, flip the flag |
| **Schema too strict** | `POST /run` rejects `null` — field typed `"string"` not `["string","null"]`; **AJV strict rejects `null` inside an enum that omits `null`** | add `null` to the type union / enum, or delete dead fields no node references |
| **Schema incoherent** | checkbox present but its revealed required children skipped → stuck "Response is required" | add schema `if/then` (present ⇒ ≥1 option, and inverse) so bad payloads fail in ms, not mid-run |
| **Workflow — null-unsafe** | `SERVER-E0002` transform error, or `XPATH_INCORRECT` from a verbatim `{{…}}` template that never resolved (input-driven) | data-contract fix, usually direct: null-coalesce the transform, filter nulls from loop arrays, guard `present?` gates — see null-safety below. `workflows update` is often enough. |
| **Workflow — mechanical bug** | genuine graph/selector defects independent of the payload: nodes out of order, XPath wrong or too brittle for the live DOM, an element clicked/typed before it's rendered (missing wait / element-not-ready race), a `select` firing before options load | **needs a human to drive a builder session** to re-observe the live page and re-author the nodes — see below. Reproduces across *every* tier (not just partials); that's how you tell it from a null bug. |
| **Site / extension** | `execution.stopped` after ~2min (upstream kill); typing race / silent data corruption seen in the video; `SERVICE_UNAVAILABLE` | not a workflow fix — file against the extension/site; don't churn the workflow |

**"Actionable" = reproducible from the data or graph contract, not a transient site
state.** `was_recovered: true` is a trap — XPath recovery can "heal" a payload-induced
`XPATH_INCORRECT` so the run goes green while writing untrustworthy data. Treat a
recovered run on a partial payload as suspicious, not passed.

**Same-input-different-outcome ⇒ flake, not a bug.** Before classifying a CLICK/select
failure as mechanical, check whether *another tier sent the identical value to the same
selector and passed*. If so it's a **timing/element-not-ready race** (esp. `CLICK`/`INPUT`
with `execution:STATIC`, `human_mode:false`, no `wait_time`), not a data-contract or graph
defect — confirm with **one re-run of the failing tier** (a flake flips to success on
retry). Fix = harden that node (add `wait_time`/`human_mode`), a builder handoff — don't
churn schema/payload. (MyUnity Recert `0d70295b` node `pti_AssignedIdent_Chk`, 2026-07-15.)

### Null-safety: the engine semantics that make this load-bearing

Why the same null bug is invisible in `full`/`empty` but fatal in a mixed mask:

- JSONata `null` interpolates to `""`; a path *through* null (`null.field`) is
  **`undefined`**, and **undefined leaves the `{{…}}` template verbatim** in the
  param — so a null *object* is worse than a null *leaf* (the literal template gets
  typed/selected into the form).
- A **thrown** JSONata expr (`$trim(null)`, `$substringBefore(null,' ')`) also leaves
  `{{…}}` verbatim.
- A STATIC BoolCondition on `""` throws "No comparison value" and takes the false
  branch (safe-ish). A **TRANSFORM eval error is fatal** — `optional:true` waives only
  the empty-output check, **not** eval errors. That asymmetry is the whole game.

Safe null-guard idioms: `x ? x : ''`, `$length($trim(x)) > 0`, `$exists()`,
`x != null ? x : ''`. **Trap:** `x != true` is unsafe when the section is null
(undefined) — use `$not(x = true)`. Array filter: `$append([], [a,b])[$ != null]`.

To answer "which fields are *truly* always-required", compute the **main trunk** — the
dominator set of nodes on every START→END path (removing one makes END unreachable).
Only unguarded trunk fields are genuinely mandatory; a field guarded by an upstream
`X provided?` BoolCondition whose false branch skips ahead is safe to null. Note
`edges` is a **dict keyed by source node id** (`{"to": tgt}` or `{"true":..,"false":..}`),
not `{source,target}` — build reverse adjacency to trace guard chains.

Watch for the **silent early-End**: a `… provided?` false branch that goes straight to
END yields a green run that filled nothing — worse than a crash.

### Applying fixes — two paths

**Direct edit** (schema fixes, null-safety): go through `cloudcruise workflows update`
(see `/cloudcruise` for read-only-field stripping and the version note). Always
**re-fetch immediately before update** to avoid a version race. Every update mints a new
version; assert node/edge counts on surgical edits. Then re-sweep to verify.

**Human-driven builder session** (mechanical bugs): re-ordering nodes, re-authoring a
brittle XPath, or inserting a wait for a not-yet-rendered element generally can't be
fixed blind from the JSON — they need someone to **re-observe the live page in a builder
session** and correct the node against what's actually on screen. Hand these off:
summarize the failing `node_id`, the tier(s) that hit it, and the screenshot/DOM
evidence, then let a human (optionally via `/builder-drive-legacy`) drive the builder to
fix it. This sweep's job is to *isolate and classify* these — not to auto-repair them.

**Telling a mechanical bug from a null bug:** a mechanical defect reproduces across
**every tier including `full`**; a null bug only fires on `empty`/`partial_*` where the
offending field is missing. Run `full` first — if it fails, you're looking at a
mechanical (or site) problem, not a data-contract one.

> **Redis cache caveat:** a schema/DB backfill alone won't fix workflows already cached
> in Redis — breaking changes need cache invalidation, or the sweep will keep hitting
> the pre-change version.

---

## Quickstart

```bash
cloudcruise workflows get <wf> > workflow.json
python3 scripts/gen_payloads.py workflow.json --outdir ./sweep
# add the vault credential key + a distinct date to each sweep/run_input_*.json
for k in full empty partial_a partial_b; do
  cloudcruise run start <wf> --input "$(cat sweep/run_input_$k.json)" | tee -a sweep/run_sessions.txt
done
./scripts/poll_all.sh "$(...session_id:label pairs...)"
# classify failures by owner (§4), fix schema/workflow, re-sweep
```
