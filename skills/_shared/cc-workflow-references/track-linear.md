# Linear track — contracts

Simple, ordered workflows: one path to the goal, with at most a few locally-resolved
decision points — nothing that needs a page/component/reveal-graph to represent.
This is about *shape* — it applies regardless of what the workflow does with what it
finds. The page already knows almost everything — census answers inventory faster
and more accurately than any other source.

## Plan body contract (short — half a page is normal)

- **Goal**: what the workflow does and where it stops (from intake, immutable).
- **Steps**: one line per move that advances toward the goal, in order, including
  decision points.
- **Data**: which screen holds it, which fields matter.
- **Open**: census questions for the build session — never asked of the human.
- Status markers on steps.

Must NOT contain: page-by-page skeletons, gating graphs, per-section inventories —
branching-contract slots that manufacture structure a linear workflow doesn't have.

## Spine

The **output shape**, for a workflow that extracts data, or the **input schema**,
for one that writes it — confirmed against census from the fields named at intake.
Node naming is plainly descriptive — isomorphism does not apply (small graphs; see
`node-naming.md`).

## Output convention (extraction, fixed, never per-workflow)

Every data-extracting linear workflow exports the same way: a screenshot node plus
an extract-datamodel node.

## Verify

The final step's target is reached — `cc-workflow-test`'s loop verifies it end to
end: did the workflow complete.

## Status

STUB — contract settled; template at `templates/plan-linear.md`.
