---
name: cc-workflow-build
description: Drive the CloudCruise builder agent through the per-component (branching) or per-step (linear) build loop for a planned workflow - explore each one, derive its schema slice, implement it via builder tasks, execute once, save as a component, and advance the plan markers. Use when a plan has unfinished components or steps.
---

# cc-workflow-build — the per-component loop

Consumes the plan; drives the builder agent over the CLI. All web interaction goes
through the builder. The plan's status markers are the only progress state — a fresh
session pointed at the plan resumes from the first unfinished component.

## Inputs

- `cc-workflows/<name>/plan.md` with at least one `[ ]` / `[→]` component or step
  ("component" below covers either — a branching plan's component or a linear
  plan's step).
- A live or new builder conversation (`builder start` / resume; write the
  `workflow_id` and `conversation_id` into the plan header, clear on `builder end`).

## The loop, per component

1. **Explore.** Earn the component's schema slice — for linear this is often one
   walk of the single path; for branching it's the step that earns its keep. The
   instrument is the builder's `interact` tool.

   **Whose tool it is.** `interact` belongs to the builder agent, not to you. You
   never call it; you tell the builder to, in the task message. It is **off by
   default** and armed by a literal `/interact` token in the message you send —
   prose about interacting ("probe the dropdown", "explore the section") never arms
   it. Unarmed, the builder silently falls back to the transient-node probe:
   authoring, running and deleting a throwaway node per probe. No error, no warning
   — just the slow path and a version bump each time. Arming persists for the
   conversation but expires after an hour idle, so arm the first explore message and
   re-arm after any long pause; repeating the token costs nothing.

   **What it does.** Touches the live page — `click`, `input` (focus, clear, type),
   `select` (native `<select>` only; the value is the option's exact visible text) —
   and **never writes to the graph**: no node, no version bump, nothing to clean up
   afterwards. The target is a `ref` from the most recent `ariaSnapshot`, or a
   validated xpath; prefer the ref. Refs from a superseded snapshot are rejected as
   stale.

   **What comes back** is a structural diff of what the page did: a `page.kind` of
   `none` / `reveal` / `hide` / `modal` / `replaced`, whether the URL changed,
   added/removed/changed counts with a summary of what appeared, fresh refs for
   everything new, and `targetState` for the element touched (`checked`, `selected`,
   `expanded`, `pressed`, `disabled`, `required`, `readonly`, `modal`, `focused`).
   Chain the next probe off the returned refs — no re-snapshot in between.

   **Read state, don't assume it.** A checkbox still toggles on a bare click, so a
   click is not "check" — but `targetState.checked` reports where it landed. Read
   the current state, then click only if it differs from the state you want, and
   confirm the result from the diff. That is state-declarative in practice even
   though the tool takes no desired-state argument.

   Act, read what appeared and disappeared, follow it, back out, try the next thing.
   Depth and order are judgment calls, not a fixed procedure. Undo test state the
   way you set it (re-click the box you ticked). Backing out is best-effort — if a
   probe can't be cleanly undone, keep exploring from the drifted-but-known state
   rather than pretending a clean baseline.

   For branching components, confirm both directions of every reveal per
   `track-branching.md` and the input-schema standard's bidirectional encoding —
   live wherever the page lets you act it back out, mirrored from the forward
   observation only when the action is genuinely irreversible (navigation, submit,
   a one-way add-without-remove, or selecting a radio option).

   **Off limits while probing:** destructive and final-submit controls — delete,
   place order, send. Dismissing a dialog or saving a form is usually fine and
   sometimes necessary.

   **When a probe surprises you** — nothing changed, the wrong element was hit, the
   diff looks wrong — screenshot and look before retrying. The failure codes are
   `no_snapshot` (probed before any snapshot), `stale_ref` (snapshot superseded —
   take a fresh one), `unresolved` (target matched nothing), `missing_value`
   (`input`/`select` without a value), `execution_failed`, `no_response`.

   If a modal or overlay gets stuck, dismiss it (Cancel/Escape) and re-seed from the
   component's entry point — assume a full page reload drops in-progress form state
   unless you've confirmed this target tolerates it.
2. **Schema slice.** This component's `input_schema` slice per the schema standard,
   if it writes, or the output shape per the track contract, if it extracts —
   whichever the component actually does, at the structure its `track-branching.md`/
   `track-linear.md` contract calls for. The slice is the hard artifact — whatever
   the component's structure is (reveal relations and exclusivity for branching, a
   flat field list for linear) lives here, not in prose. A `<select>`'s option list
   truncates past 6 in the snapshot (`... N more options`) — on that marker the
   enum has to come from the page HTML, not the probe, or you ship a truncated
   enum that validates and then fails on the seventh option.
3. **Implement.** One builder task per component, composed per the task-message
   contract: goal + exact input paths + status skeleton. Goal, not clicks. Register
   scales with the track — branching's fuller anatomy or linear's bare dispatch, per
   `task-messages.md`'s two worked examples.
4. **Execute once.** A single in-browser `executeWorkflow`, watched synchronously,
   graded against the component's done-means invariant. **Once means once:** a failed
   fill has already mutated the page, so re-running the same action fails on
   side-effect state, not node correctness — it lies about the fix. Log fail and move
   to the next component; free to inspect the failed page via DOM fetch or
   screenshot — never by probing it with `interact`, which still acts on the live
   page even though it creates no node. Never retry the mutating action or reopen a
   prior component to re-fill it. Never trigger a real backend run from this loop.

   **Once, from where the component starts** — not from Start. Execute from the
   component's first node, or from the first node that runs cleanly given the
   current browser state, which is usually the same thing. Re-running the whole
   graph per component re-does every prior side effect (a fresh record per
   component, on a live system) and grades the new component against a page that
   arrived by a different route. Treat "usually the component's first node" as a
   default, not a rule.

   Pick an **unguarded** node as the execution target. Targeting a node whose own
   `run_if` skips it for this payload reports `no longer reachable from current
   position` — a false failure that reads exactly like a broken node.
5. **Create a reusable component** — pass or fail, not blocking. Send the builder a
   follow-up task explicitly asking it to create a reusable component from the
   nodes built for this plan component. Give the component name and identify the
   exact node set. This is distinct from saving the workflow.
6. **Mark and advance.** Update the plan marker, move to the next component.

## How much to verify, and when

Per component, the check is the done-means invariant and nothing more. Grading a
component is not the same as auditing the graph, and the builder's own report is
not evidence — read the artifact when the claim matters (a schema slice it says it
wrote, a guard it says it added), skip the ceremony when it doesn't.

Save the mechanical sweep for boundaries — the end of a page, or a run of
components sharing one shape — and once before handoff. Sweeping every component
costs more than it finds, because most components repeat the shape the last one
established; the value is in catching the shape that drifted, which a boundary
check catches just as well and forty times less often.

The sweep is: reachability from Start (orphans, non-END nodes with no outgoing
edge), a `run_if` on every field node, guard value ↔ enum member ↔ selector text
compared character-for-character (a curly apostrophe in a label matches nothing and
fails silently), and the schema compiled under the platform's validator with a
null-everything payload and a full payload. That last pair is the one that earns
its place: `save` rejects a schema that fails to *compile*, but a slice that
compiles and still contradicts its own guards — a non-nullable leaf under an
`IS_NOT_NULL` skip — passes save and dies at run start.

## Handoff-ready

- All components `[x]`; one clean full in-browser execute completes.
- If `complexity: branching`: every schema leaf appears in a node name (grep check).
- If the workflow has a final submit/save node: it carries `end_here_on_dry_run: true`.

Hand off to `cc-workflow-test`. Firing real runs belongs to the test stage, not here.

## References

- `references/input-schema.md` — the schema standard (workflows that write).
- `references/task-messages.md` — every builder message.
- `references/node-naming.md` — node naming (branching workflows).
- `references/track-branching.md` / `track-linear.md` — spine + verify
  definitions for the drafted `complexity`.
- The `cloudcruise` CLI skill for command mechanics; the `cloudcruise-workflow-dsl`
  skill for node semantics.

## Status

Loop settled. Explore is documented against the real `interact` tool, which is
opt-in per conversation (`/interact`) and ships on the monorepo `interact-tool`
branch. Where it isn't available the step still works — the builder falls back to
the transient-node probe, slower and one version bump per probe.
