---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow inside builder-agent dry-runs — generate null/partial/full schema-valid payloads, dry-run each to the end, investigate errors with the interact tool, fix the confident ones live and block the rest, and hand back an errors+fixes ledger. Use when a plan's build markers are all done.
---

# cc-workflow-test

Never fires a real backend run. Testing happens inside one continuous builder session, dry-run,
driven by the interact tool. The same loop runs for every workflow.

## The loop

Run three payload modes, each a fresh dry-run from the start:

1. **Generate the payloads** — `cloudcruise workflows gen-payloads <id>` (below).
2. **Dry-run the mode to the end** in the builder session.
3. **On each error, investigate → fix or block** (below). Continue to the end.
4. **After any fix, verify** (below).
5. **Log the errors and their fixes** to the ledger.

Run order: `null`, `full`, then one or more `partial` variants (regenerate for more).
Fixes accumulate — each mode runs on the current, already-fixed workflow.

## Payload generation (`cloudcruise workflows gen-payloads`)

The server derives payloads from the workflow's input_schema with the same validator `run`
enforces at run-start, so every payload is one a run will accept. Schema changes flow into
payloads with no client work.

```bash
cloudcruise workflows gen-payloads <id> --profile <name>
# → { payloads: [ { name, mode, payload, expectedOutcome? } ] }
```

Write each payload into `cc-workflows/<name>/payloads/`, then merge the test-rig `envelope`
(below) into every one before dry-running.

The spread covers three modes, each catching a different bug class:

- **null** — every key present, leaves null, arrays empty. Production cold-start; catches
  self-gating bugs (a `run_if` that should skip on an absent field but fires).
- **full** — maximal coherent path; every reveal opens, so every detail node renders at least once.
  Catches actuation/selector/timing bugs.
- **partial** — mixed leaves. The only mode that catches gating-boundary bugs — mixed state makes
  two controls diverge, which full (all open) and null (all closed) both miss.

- **Envelope** — task-selection fields set verbatim in every payload (a run that can't find its
  task tests nothing). Keep them in `cc-workflows/<name>/payloads/config.json` and merge into each
  payload; they carry real test-rig identifiers, so gitignore that file if it matters.
- **Vault** — alias → permissioned_user_id for the dry-run's credential selection.
- Regenerate after **every** input_schema change.

## Error handling — fix the sure ones, block the rest

On each error during a dry-run:

1. **Investigate with the interact tool first.** Get the DOM-grounded root cause — see what's
   actually on the page before deciding anything. No fix without a diagnosis.
2. **Fix in place only if the fix is mechanical and certain — no guess about intended behavior.**
   Then verify (below) and continue to the end.
   - **Fix**: selector correction (DOM-validated), timing/wait, stale-reference repoint, nbsp-safe
     or scope-narrowed match.
   - **Block**: which value is correct, whether a node belongs here, business logic, anything
     ambiguous. Stop, hand the human the diagnosis, ask them for the fix.
3. **A fix that doesn't make the run proceed gets one retry, then block.** No spiral.

A wrong fix masks the real bug and hands back false confidence — worse than a block. When
confidence isn't there, block.

### Verify after a fix (each mode)

Re-run the full chain to confirm the fix and that nothing upstream regressed. Assess in order:

1. **Re-run from start.** → `verified-full`.
2. If a from-start re-run is blocked (dirty form state, consumed task, no-reload constraint),
   **restore to a runnable point, then run from there.** → `verified-partial`.
3. If you can neither re-run nor restore, **don't attempt** — mark the fix `unverified`. Never fake
   a verification.

## Outputs

- `cc-workflows/<name>/payloads/` — payload files (record which modes you ran in the ledger).
- `cc-workflows/<name>/ledger.md` — errors + fixes, from `references/templates/test-audit.md`:
  per error, `where · what failed · root cause · fix · verification`, or `blocked: <what's needed>`.
- Rules discovered during testing (value constraints, null semantics, timing) codified back into
  the input_schema — never left as tribal knowledge.

## References

- `references/track-branching.md` / `track-linear.md`.
- `references/input-schema.md` — payload generation reads the same standard the build wrote.
- `references/templates/test-audit.md`.

## Status

PARTIAL — payload generation is `workflows gen-payloads` (server-backed); fix-first error handling
depends on the interact tool, still in development. No real-run CLI surface is touched.
