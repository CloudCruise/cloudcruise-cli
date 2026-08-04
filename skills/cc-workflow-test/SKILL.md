---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow with real runs. Form workflows get a hardening loop (schema-derived payload permutations, run, diagnose, fix, re-run, with reset discipline). Scrape workflows get an acceptance gate (input-to-expected-output pairs, run freely, compare). Use when a plan's build markers are all done.
---

# cc-workflow-test — real runs against expectations

The first stage allowed to fire real backend runs. Forks by the mutation axis:

## Form — hardening loop (failures expected; fixing them is the point)

1. **Payloads.** Generate with `scripts/gen-payloads.mjs` — the reveal graph IS the
   map, and it lives in the input_schema's rules, which the script enforces via an
   AJV repair loop (backend-parity options). Ask the user which payload classes they
   want; store each with its expected observable outcome.
2. **Reset.** Before each run, the form's start state must be known-clean. The plan's
   `## Reset` section documents what a run dirties and how to undo it (human-performed
   for now). The submitted payload is the undo manifest.
3. **Run** (`run start --debug`), poll to terminal, pull structured errors and
   per-node screenshots.
4. **Diagnose → fix → re-run.** First-run heuristic: piecemeal build execution had
   natural pauses a full run doesn't — expect timing gaps; the fix is usually a
   delay, not a selector. Log every run in the audit file.
5. Loop until green across the payload set or max iterations.

## Payload generation (`scripts/gen-payloads.mjs`)

Generates input_schema-valid payloads: naive fill, then a repair loop against AJV
(same options as the backend validator) until valid. All reveal/coherence rules are
enforced from the schema itself — schema changes flow into payloads with no script
changes. Enum values are seeded-random sampled (null and refusal/absence options
excluded; `Other:` included so its reveal chains get exercised). Zero-install: ajv is
vendored (`scripts/ajv.bundle.mjs`, pinned to the backend's version).

```bash
node <skill>/scripts/gen-payloads.mjs \
  --workflow <id>                  # or --schema workflow.json
  --config cc-workflows/<name>/payloads/config.json \
  [--out dir] [--seed 7] [--modes null,partial,full] [--partial-p 0.5]
```

- **Artifacts** default to `cc-workflows/<workflow-name-slug>/payloads/` in the
  project directory the command runs from (payload files + `manifest.json` recording
  the seed). Config lives beside them; it carries real test-rig identifiers
  (patient/task names, credential ids) — gitignore it if that matters.
- **Config**: `envelope` (task-selection fields set verbatim in every payload — a run
  that can't find its task tests nothing), `vault` (alias → permissioned_user_id),
  `scenarios` (named dotted-path overrides on a base mode, repaired to coherence —
  for branches the standard modes never reach).
- **Modes**: `null` = full skeleton (every key present, leaves null, arrays empty);
  `full` = maximal coherent path; `partial` = keep each leaf with probability
  `--partial-p`, then repair.
- Same seed → identical payloads (record the seed in the audit file); bump the seed
  to exercise different enum choices and reveal chains.
- Regenerate after **every** input_schema change. For scenario tests needing
  meaningful values rather than just valid ones, edit a generated payload and
  re-validate — never hand-build from scratch.

## Failure triage — workflow amendment vs schema amendment

| Signature | Amend |
|---|---|
| `PREREQUISITE_NOT_MET` (element never rendered) | schema — missing reveal rule / converse gate between dependent and control |
| `NO_MATCHING_OPTION` / selector text mismatch | schema — enum drifted from live UI text (casing, punctuation) |
| Click "succeeds" but page state unchanged | workflow — selector hits a non-interactive element (checkbox labels can carry trailing `&nbsp;`: use container-scoped `contains(normalize-space(), ...)`, never equality) |
| Node ran on / skipped the wrong data | workflow — missing or wrong `run_if` (`NOT_EQUAL` on a null field evaluates false = skip) |
| 400 at run start | payload stale vs schema — regenerate; if fresh payloads still 400, the schema change is wrong |
| Field never entered, no error | workflow — node dead-gated on a schema path that no longer exists; check run_if fields against the schema |

After a schema amendment: regenerate payloads, re-run. After a node amendment inside
a component: update the component and propagate — then verify every consumer workflow
actually received it (propagation failures can be silent).

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

PARTIAL — payload generation + failure triage implemented; run/reset/audit loop body to be written.
