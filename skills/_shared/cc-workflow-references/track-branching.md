# Branching track — contracts

Goal-oriented workflows with real decision structure: multiple pages/screens,
conditional reveals, enough interdependent state that a flat step list can't
represent it. This is about *shape* — it applies regardless of what the workflow
does with what it finds.

## Plan body contract

- **Skeleton**: pages in order, components per page, gating relations. A component
  sits between page and element — usually a section, but the boundary is drawn by
  task size, not fixed structure: merge trivial adjacent sections into one
  component, split a complex or heavily-gated section into more than one. Never a
  whole page (too large for one builder task); never a single element (that's
  inventory, discovered live at build time, not skeleton structure).
- **Per-component**: goal, done-means invariant, narrated rules quoted near-verbatim.
  Inventory marked census-pending — never transcribed as truth.
- Status markers `[ ]` / `[→]` / `[x]` per component; the plan is the progress tracker.

## Spine

The **input schema** (see `input-schema.md`). Explore earns each component's slice;
implement spends it; node names mirror it (see `node-naming.md`).

## Verify

`cc-workflow-test`'s loop verifies the whole graph together — did the workflow
complete. Build doesn't grade per component; the component-owning turn proves each
runs and advances.

## Patterns

Interaction mechanisms go to the shared patterns library (explicit statements only,
one entry per mechanism, write-back mandatory when a build investigates an unmatched
component).
