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
   walk of the single path; for branching it's the step that earns its keep. Drive
   the interact tool (click/input/select; ephemeral — no nodes created) directly
   against the live component. A checkbox toggles via a bare click (always flips;
   confirm the resulting state from the diff, not an assumption) — there's no
   state-declarative check/uncheck yet. Act, read what appeared/disappeared, follow
   it, back out, try the next thing. The tool's job is to observe well; depth and
   order are judgment calls, not a fixed procedure. Backing out is best-effort, not
   guaranteed — if a probe can't be cleanly undone, continue exploring from the
   drifted-but-known state rather than assuming a clean baseline.
   For branching components, confirm both directions of every reveal per
   `track-branching.md` and the input-schema standard's bidirectional encoding —
   live wherever the page lets you act it back out, mirrored from the forward
   observation only when the action is genuinely irreversible (navigation, submit,
   a one-way add-without-remove, or selecting a radio option).
   If a modal or overlay gets stuck, dismiss it (Cancel/Escape) and re-seed from the
   component's entry point — assume a full page reload drops in-progress form state
   unless you've confirmed this target tolerates it.
2. **Schema slice.** This component's `input_schema` slice per the schema standard,
   if it writes, or the output shape per the track contract, if it extracts —
   whichever the component actually does, at the structure its `track-branching.md`/
   `track-linear.md` contract calls for. The slice is the hard artifact — whatever
   the component's structure is (reveal relations and exclusivity for branching, a
   flat field list for linear) lives here, not in prose. A revealed dropdown's
   option list truncates past 6 in the diff (`... N more options`) — on that marker,
   fetch the page HTML and parse the full list rather than writing a truncated enum.
3. **Implement.** One builder task per component, composed per the task-message
   contract: goal + exact input paths + status skeleton. Goal, not clicks. Register
   scales with the track — branching's fuller anatomy or linear's bare dispatch, per
   `task-messages.md`'s two worked examples.
4. **Execute once.** A single in-browser `executeWorkflow`, watched synchronously,
   graded against the component's done-means invariant. **Once means once:** a failed
   fill has already mutated the page, so re-running the same action fails on
   side-effect state, not node correctness — it lies about the fix. Log fail and move
   to the next component; free to inspect the failed page via DOM fetch or
   screenshot — never via the interact tool, which still acts on the live page even
   though it doesn't create nodes. Never retry the mutating action or reopen a prior
   component to re-fill it. Never trigger a real backend run from this loop.
5. **Save as component** — pass or fail, not blocking.
6. **Mark and advance.** Update the plan marker, move to the next component.

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

PARTIAL — loop settled; the explore step's interact tool is still in development.
