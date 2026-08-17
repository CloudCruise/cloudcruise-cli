---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow entirely inside builder-agent dry-runs - generate schema-derived payloads, dry-run each to the end, disposition failures (log/fix/block), grade on completion. One loop for every workflow. Use when a plan's build markers are all done.
---

# cc-workflow-test — runs against expectations

Never fires a real backend run — testing happens entirely inside one continuous
builder session, dry-run, driven by interact for diagnosis. The same loop runs for
every workflow; `complexity` doesn't reach into this skill, and neither does what the
workflow does with what it finds.

## The loop

1. **Source test cases.** Generate with `scripts/gen-payloads.mjs` — the reveal
   graph IS the map, enforced via the AJV repair loop. Ask the user which payload
   classes they want; specific known-important cases go through the script's
   `scenarios` config rather than a separate hand-authored mechanism.
2. **Dry-run the case to the end**, in the builder session. On a stall or error,
   use interact/snapshot to see what's actually on the page before deciding anything.
3. **Disposition, per failure** — three options, and which one applies is judgment,
   not a formula:
   - **Log and move on** — the default. Note it and keep going if the workflow lets
     you continue past it; come back to it once the pass finishes.
   - **Fix and rewind** — only when continuing is otherwise impossible and the fix is
     small and mechanical (bad selector, timing, a stale reference) — correct it,
     restore the page to this point with `interact`, then re-run once.
   - **Block and alert** — anything that would require guessing intended behavior
     rather than mechanics. Never guess business logic; surface it for a human.
4. **Grade: did the workflow complete.**
5. Log every disposition to the audit file. Loop until the case set is exhausted or
   nothing left is unblocked.

No fixing beyond the mechanical case above happens in this loop by default — the
report is the point. A human reviews it and iterates with the builder afterward.

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
  [--out dir] [--seed 7] [--modes null,partial,full,sparse] [--partial-p 0.5] \
  [--policy widen|narrow] [--prefer-triggers true|false]
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
  `--partial-p`, then repair; `sparse` = every leaf filled but **width-1** — one value per
  multi-select, one row per object array, so each section shows a single vertical slice.
- **`sparse` needs `--policy narrow`.** The tradeoff between widening a list back to N
  vs. blanking the unreachable detail is explained in the script's own comments —
  read there if the choice ever needs revisiting.
- **`--prefer-triggers`** (default on for `sparse`) biases enum sampling toward values
  that open a reveal, so a single sparse selection still exercises the sub-tree below
  it instead of landing on a closed leaf.
- Same seed → identical payloads (record the seed in the audit file); bump the seed
  to exercise different enum choices and reveal chains. For sparse this matters more than
  for other modes: a run only ever samples 1-of-N per list, so **rotate the seed across
  runs** — the union of several sparse runs is where the option tail gets covered.
- `manifest.exclusions` records every enum value withheld as a refusal/absence option and
  the rule that caught it, plus `kept_but_negative_looking` for values that read negative
  but are real findings ("No added salt", "No willing/able caregiver"). Read it: the
  filter is a judgement call per value, not a fact.
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
| Payload rejected before the dry run starts | payload stale vs schema — regenerate; if a fresh payload still rejects, the schema change is wrong |
| Field never entered, no error | workflow — node dead-gated on a schema path that no longer exists; check run_if fields against the schema |

After a schema amendment: regenerate payloads, re-run. After a node amendment inside
a component: update the component and propagate — then verify every consumer workflow
actually received it (propagation failures can be silent).

## Outputs

- `cc-workflows/<name>/payloads/` — payload files, each with expected outcome.
- `cc-workflows/<name>/audit.md` — one line per run: payload → session → verdict →
  disposition.
- Rules discovered during testing (value constraints, null semantics) codified back
  into the input_schema — never left as tribal knowledge.

## References

- `references/track-branching.md` / `track-linear.md`.
- `references/input-schema.md` — payload generation reads the same
  standard the build wrote.
- `references/templates/test-audit.md`.

## Status

PARTIAL — payload generation + failure triage implemented; one loop for every
workflow, no real-run CLI surface touched at all; depends on the interact tool,
which is still in development.
