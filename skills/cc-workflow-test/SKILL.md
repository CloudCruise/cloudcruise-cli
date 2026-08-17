---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow inside builder-agent dry-runs — run the build's example input set through to the end, investigate errors with the interact tool, fix the confident ones live and block the rest, and hand back an errors+fixes ledger. Use when a plan's build markers are all done.
---

# cc-workflow-test

Never fires a real backend run. Testing happens inside one continuous builder session, dry-run,
driven by the interact tool. The same loop runs for every workflow.

If the plan header carries a live `conversation_id` (the build stage hands its session over
rather than ending it), reuse that conversation — the browser is already logged in and
positioned. Start a fresh one only when none is live: `builder edit --workflow <id>
--open-builder --use-example-inputs`. Clear `conversation_id` from the plan
header when this stage ends the session.

## The loop

One dry-run of the build's example input set, through the fix pipeline:

1. **Dry-run to the end** in the builder session, using the example input set the build left
   on the workflow.
2. **On each error, investigate → fix or block** (below). Continue to the end.
3. **After any fix, verify** (below).
4. **Log the errors and their fixes** to the ledger.

## The input set

Testing runs the example input set the build process created (the `--use-example-inputs`
values the workflow already carries) — one set, one pass, no generation. It already includes
whatever a run needs to select and reach its task, since the build ran the workflow with it.
Multi-mode coverage (null/full/partial) is deferred; see Status.

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

### Verify after a fix

Re-run the full chain to confirm the fix and that nothing upstream regressed. Assess in order:

1. **Re-run from start.** → `verified-full`.
2. If a from-start re-run is blocked (dirty form state, consumed task, no-reload constraint),
   **restore to a runnable point, then run from there.** → `verified-partial`.
3. If you can neither re-run nor restore, **don't attempt** — mark the fix `unverified`. Never fake
   a verification.

## Outputs

- `cc-workflows/<name>/ledger.md` — errors + fixes, from `references/templates/test-audit.md`:
  per error, `where · what failed · root cause · fix · verification`, or `blocked: <what's needed>`.
- Rules discovered during testing (value constraints, null semantics, timing) codified back into
  the input_schema — never left as tribal knowledge.

## References

- `references/track-branching.md` / `track-linear.md`.
- `references/input-schema.md` — the standard the build wrote; codify discovered rules back into it.
- `references/templates/test-audit.md`.
