---
name: cc-workflow-build
description: Drive the CloudCruise builder agent through the per-component build loop for a planned workflow - explore each component, derive its schema slice, implement it via builder tasks, execute once, save as component, and advance the plan markers. Use when a plan has unfinished components.
---

# cc-workflow-build — the per-component loop

Consumes the plan; drives the builder agent over the CLI. All web interaction goes
through the builder. The plan's status markers are the only progress state — a fresh
session pointed at the plan resumes from the first unfinished component.

## Inputs

- `cc-workflows/<name>/plan.md` with at least one `[ ]` / `[→]` component.
- A live or new builder conversation (`builder start` / resume; write the
  `workflow_id` and `conversation_id` into the plan header, clear on `builder end`).

## The loop, per component

1. **Explore.** Earn the component's schema slice:
   - First, look for the gift: a server-side data contract (XHR payloads, embedded
     JSON, export endpoints) that already describes the fields.
   - Otherwise: census the live DOM (snapshot-harvest for inventory truth), plus
     builder exploration tasks for what needs a live hand (conditional reveals,
     dynamic widgets).
2. **Schema slice.** Form: this component's `input_schema` slice per the schema
   standard. Scrape: the output shape per the track contract. The slice is the hard
   artifact — reveal relations, enums, exclusivity live here, not in prose.
3. **Implement.** One builder task per component, composed per the task-message
   contract: goal + exact input paths + status skeleton. Goal, not clicks.
4. **Execute once.** A single in-browser `executeWorkflow`, watched synchronously,
   graded against the component's done-means invariant. **Once means once:** a failed
   fill has already mutated the page, so a retry fails on side-effect state, not node
   correctness — it lies about the fix. Log fail and continue; never re-probe or
   re-open a prior component. Never trigger a real backend run from this loop.
5. **Save as component** — pass or fail, not blocking.
6. **Mark and advance.** Update the plan marker, move to the next component.

## Handoff-ready

- Form: all components `[x]`; every schema leaf appears in a node name (grep check);
  final submit carries `end_here_on_dry_run: true`; one clean full in-browser execute.
- Scrape: all components `[x]`; the execute returns expected records for a known input.

Hand off to `cc-workflow-test`. Firing real runs belongs to the test stage, not here.

## References

- `references/input-schema.md` — the schema standard (form).
- `references/task-messages.md` — every builder message.
- `references/node-naming.md` — node naming (form).
- `references/track-form.md` / `track-scrape.md` — spine + verify
  definitions for the kind.
- `references/operating-rules.md` — always.
- The `cloudcruise` CLI skill for command mechanics; the `cloudcruise-workflow-dsl`
  skill for node semantics.

## Status

STUB — contract settled, body to be written.
