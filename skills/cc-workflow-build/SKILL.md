---
name: cc-workflow-build
description: Drive the CloudCruise builder agent through the build loop for a planned workflow - each task hands the builder one component to explore (interact), build, prove, and save as a component; the builder runs it through or stops to ask, then the plan markers advance. Use when a plan has unfinished components or steps.
---

# cc-workflow-build — the per-component loop

Consumes the plan; drives the builder agent over the CLI. All web interaction goes
through the builder. The plan's status markers are the only progress state — a fresh
session pointed at the plan resumes from the first unfinished component.

## Inputs

- `cc-workflows/<name>/plan.md` with at least one `[ ]` / `[→]` component or step
  ("component" below covers either — a branching plan's component or a linear
  plan's step).
- A live or new builder conversation (`builder start` / resume — pass `--open-builder` on the session-opening `builder start`/`builder edit`, and `--use-example-inputs` on `builder edit` (empty template variables cause selector timeouts); write the `workflow_id` and `conversation_id` into the plan header, clear on `builder end`).

## The loop, per component

**The task is one component, stated as a goal.** The builder carries it through one
turn — explore with interact, build the nodes, prove them, save the component — or
stops partway and hands back for direction. What a turn covers:

### Explore and build

Explore only as far as the component needs; build as soon as a probe tells you
enough. Chain while probes come back clean; when one surprises you, back up and
follow what changed.

**Interact.** The turn's exploration instrument is the builder's `interact` tool —
it belongs to the builder, not to you; you never call it, you describe the state the
turn needs and the builder drives the page.

**What it does.** Touches the live page — `click`, `input` (focus, clear, type),
`select` (native `<select>` only; the value is the option's exact visible text) —
and **never writes to the graph**: no node, no version bump, nothing to clean up.
That makes it the tool for putting the page into whatever state the turn needs — an
unknown one to learn from (explore), a known position after a session boundary
(resume), or a known base (restore). The target is a `ref` from the most recent
`ariaSnapshot`, or a validated xpath; prefer the ref. Refs from a superseded
snapshot are rejected as stale.

**Resume positioning.** To position a fresh browser at the frontier, drive it there
with interact — not by executing the built nodes. Replaying the graph re-does every
prior side effect and can stall on any node that isn't cleanly replayable.

**What comes back** is a structural diff of what the page did: a `page.kind` of
`none` / `reveal` / `hide` / `modal` / `replaced`, whether the URL changed,
added/removed/changed counts with a summary of what appeared, fresh refs for
everything new, and `targetState` for the element touched (`checked`, `selected`,
`expanded`, `pressed`, `disabled`, `required`, `readonly`, `modal`, `focused`).
Chain the next probe off the returned refs — no re-snapshot in between.

**Read state, don't assume it.** A checkbox still toggles on a bare click, so a
click is not "check" — but `targetState.checked` reports where it landed. Read the
current state, then click only if it differs from the state you want, and confirm
the result from the diff.

A reveal may or may not already be in the static DOM before you actuate the control
that triggers it — absence of conditional markup is not absence of a reveal. So "no
reveal" is only ever an observed result, a `page.kind: none` diff from actually
clicking, never an inference from how the unactuated page looks.

Act, read what appeared and disappeared, follow it, back out, try the next thing —
then build the nodes the probes justified. Depth and order are judgment calls, not a
fixed procedure. Undo test state the way you set it (re-click the box you ticked).
Backing out is best-effort — if a probe can't be cleanly undone, build from the
drifted-but-known state rather than pretending a clean baseline.

**Off limits while probing:** destructive and final-submit controls — delete, place
order, send. Dismissing a dialog or saving a form is usually fine and sometimes
necessary. Never trigger a real backend run from this loop.

**When a probe surprises you** — nothing changed, the wrong element was hit, the diff
looks wrong — screenshot and look before retrying. The failure codes are
`no_snapshot` (probed before any snapshot), `stale_ref` (snapshot superseded — take a
fresh one), `unresolved` (target matched nothing), `missing_value` (`input`/`select`
without a value), `execution_failed`, `no_response`. If a modal or overlay gets
stuck, dismiss it (Cancel/Escape) and re-seed from the component's entry point —
assume a full page reload drops in-progress form state unless you've confirmed this
target tolerates it.

**Schema is a code gate.** A component that writes produces its `input_schema` slice
per the standard — the hard artifact, carrying the reveal relations and exclusivity
for branching or the flat field list for linear. The scar rules (`then.properties`
not `then.required`, null-is-absence typing, `additionalProperties: false` on every
object, `contains` with a sibling `type: array`) are enforced by the AJV gate. A
`<select>`'s option list truncates past 6 in the snapshot (`... N more options`); on
that marker the enum comes from the page HTML, not the probe, or a truncated enum
validates and then fails on the seventh option.

**Prove it, from the component's start.** Run the built nodes to confirm they reach
the target without erroring. Run from the component's first node, or the first that
runs cleanly given current browser state — **never from Start**: re-running the whole
graph re-does every prior side effect (a fresh record per component, on a live
system) and grades the component against a page that arrived by a different route.
Pick an **unguarded** target — a node whose own `run_if` skips it for this payload
reports `no longer reachable from current position`, a false failure that reads like
a broken node. Never a real backend run. On a fail, a bare re-run grades the page the
last attempt already mutated, not the fix — restore a clean base with `interact` and
retry, or hand back.

**Save as a component.** After proving the nodes, save the reusable component from
them in the same turn. Name the component and the exact node set. Saving a component
is distinct from saving the workflow.

### Advance

When a component is done, mark it `[x]` and move to the next. When the builder stops
to ask, `builder await-turn` exits `7` with the question on stdout — relay it,
get direction, mark `[→]`, and resume the same conversation.

## Awaiting a builder turn

After sending the builder a task, await the turn with `cloudcruise builder
await-turn` — it blocks until the turn settles and prints the report to stdout:

```bash
cloudcruise builder send --conversation "$CID" "$(cat task.txt)"
cloudcruise builder await-turn --conversation "$CID" --profile "$PROFILE"
```

The exit code is the outcome — branch on it, don't parse stdout:

- `0` — completed; stdout is the report. Mark the plan, send the next.
- `7` — awaiting human input (prompt on stdout); relay it, `builder respond`, await again.
- `8` — agent errored (state on stdout); diagnose with `builder messages`.
- `9` — timed out still processing; the turn may still be running — await again.
- other — a CLI/API failure on stderr; stop.

## Handoff-ready

- All components `[x]`.
- If the workflow has a final submit/save node: it carries `end_here_on_dry_run: true`.

When both hold, invoke `cc-workflow-test` (Skill tool) immediately. Do not gate on
the user. Keep the builder session alive and continue — the test stage reuses its
logged-in browser. Leave `conversation_id` in the plan header; the test stage clears
it when it ends the session. Do not fire real runs here; the test stage owns them.

## References

- `references/input-schema.md` — the schema standard (workflows that write).
- `references/task-messages.md` — every builder message.
- `references/node-naming.md` — node naming (branching workflows).
- `references/track-branching.md` / `track-linear.md` — spine definitions for the
  drafted `complexity`.
- The `cloudcruise` CLI skill for command mechanics; the `cloudcruise-workflow-dsl`
  skill for node semantics.
