---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow with real runs. Form workflows get a hardening loop (schema-derived payload permutations, run, diagnose, fix, re-run, with reset discipline). Scrape workflows get an acceptance gate (input-to-expected-output pairs, run freely, compare). Use when a plan's build markers are all done.
---

# cc-workflow-test — real runs against expectations

The first stage allowed to fire real backend runs. Forks by the mutation axis:

## Form — hardening loop (failures expected; fixing them is the point)

1. **Payloads.** Generate from the input_schema — the reveal graph IS the map. Valid
   permutations are paths through the if/then/else edges; coverage = every reveal
   edge exercised at least once triggered and once hidden. Ask the user which payload
   classes they want; store each with its expected observable outcome.
2. **Reset.** Before each run, the form's start state must be known-clean. The plan's
   `## Reset` section documents what a run dirties and how to undo it (human-performed
   for now). The submitted payload is the undo manifest.
3. **Run** (`run start --debug`), poll to terminal, pull structured errors and
   per-node screenshots.
4. **Diagnose → fix → re-run.** First-run heuristic: piecemeal build execution had
   natural pauses a full run doesn't — expect timing gaps; the fix is usually a
   delay, not a selector. Log every run in the audit file.
5. Loop until green across the payload set or max iterations.

## Scrape — acceptance gate (failures are surprises)

1. **Pairs.** User dumps input → expected-output pairs in whatever shape; format them
   into payloads conforming to the input_schema.
2. **Run freely.** Reads are idempotent — no reset, no execute-once ceremony.
3. **Grade:** run green AND output matches expected, under the workflow's declared
   match policy (exact vs subset/contains — declared next to the pairs, since scraped
   records carry volatile fields).
4. **Diagnose misses.** Same first-run timing heuristic applies. There shouldn't be a
   fix loop; if one develops, that's signal about the build, not the test.

## Outputs

- `cc-workflows/<name>/payloads/` — payload files, each with expected outcome
  (and match policy, for scrape).
- `cc-workflows/<name>/audit.md` — one line per run: payload → session → verdict →
  disposition.
- Rules discovered during testing (value constraints, null semantics) codified back
  into the input_schema — never left as tribal knowledge.

## References

- `references/track-form.md` / `track-scrape.md`.
- `references/input-schema.md` — payload generation reads the same
  standard the build wrote.
- `references/templates/test-audit.md`.
- `references/operating-rules.md` — always; productionized workflows
  are read-only without explicit authorization.

## Status

STUB — contract settled, body to be written.
