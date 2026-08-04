# Scrape track — contracts

Read-only extraction: a lookup key goes in, records come out, nothing is submitted.
The page already knows almost everything — census answers inventory faster and more
accurately than any other source. The only thing the human owns is **scope**, settled
at goal intake before anything else happens.

## Plan body contract (short — half a page is normal)

- **Goal**: input key · output fields · where it stops (from intake, immutable).
- **Steps**: one line per move that advances toward the data, in order, including
  decision points.
- **Data**: which screen holds it, which fields are the output.
- **Open**: census questions for the build session — never asked of the human.
- Status markers on steps.

Must NOT contain: page-by-page skeletons, gating graphs, save points, per-section
inventories — form-contract slots that manufacture structure a scrape doesn't have.

## Spine

The **output shape**, confirmed against census from the fields named at intake.
Node naming is plainly descriptive (isomorphism does not apply).

## Output convention (fixed, never per-workflow)

Every scrape exports the same way: a screenshot node plus an extract-datamodel node.

## Verify

Data-shaped: the execute returns the expected records for a known input. At test
time this becomes the acceptance gate — input→output pairs, run freely (reads are
idempotent), grade green + match under the workflow's declared match policy.

## Status

STUB — contract settled; template at `templates/plan-scrape.md`.
