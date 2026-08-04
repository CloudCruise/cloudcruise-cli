# Form track — contracts

Write-heavy workflows: a payload goes in, a form gets filled and saved/submitted.
Mutation governs everything: execute-once, reset discipline, the hardening test loop.

## Plan body contract

- **Skeleton**: pages in order, components per page, gating relations, save points.
- **Per-component**: goal, done-means invariant, narrated rules quoted near-verbatim.
  Inventory marked census-pending — never transcribed as truth.
- **Scope**: what gets built and what explicitly does not.
- **Reset**: what a run dirties and how to undo it (human-performed for now; the
  submitted payload is the undo manifest).
- Status markers `[ ]` / `[→]` / `[x]` per component; the plan is the progress tracker.

## Spine

The **input schema** (see `input-schema.md`). Explore earns each component's slice;
implement spends it; node names mirror it (see `node-naming.md`).

## Verify

Page-state invariant: the debug execution succeeds and the screenshot shows the
component correctly filled per its done-means. Save checkpoints follow the page's own
save ritual from the plan.

## Patterns and quirks

Interaction mechanisms go to the shared patterns library (explicit statements only,
one entry per mechanism, write-back mandatory when a build investigates an unmatched
component). Quirks route to their consumer: done-means invariant, driving rule, or —
only as residue — a "might be helpful" line in the task message.

## Status

STUB — contract settled; template at `templates/plan-form.md`.
