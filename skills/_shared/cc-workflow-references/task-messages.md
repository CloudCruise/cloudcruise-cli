# Builder task messages

The shape of one message to the builder agent. A task is the unit of dispatch: one
component (or one exploration), one builder turn, one verifiable outcome.

## Anatomy (settled)

1. **Goal** — what must be true when done. Outcome, not procedure.
2. **Location** — page/section by on-form name.
3. **Inputs** — known (exact `context.inputs.…` paths from the schema slice) or
   to-discover (exploration is a first-class task, not a failure to prepare one).
4. **Status skeleton** — compact whole-build progress block so the builder knows
   where this task sits. Never the full plan, other components' details, or history.
5. **Conventions** — inputs via `{{context.inputs.…}}` never literals; `run_if`
   gating stated as data; node naming per the naming reference; the pattern contract
   if the component matched one.

## Rules (settled)

- Goal, not clicks. Never selectors, execution types, or node structure.
- One component per task; "and then" means split.
- Text only — the builder's page access beats any image.
- Exact paths verbatim; a paraphrased path wires the wrong variable silently.
- Default completion: a debug execution succeeds and the component's done-means
  invariant holds. Spell out extras only for unusual components.

## Status

STUB — port from the internal task-messages doc (content above is the settled
contract; worked examples pending).
