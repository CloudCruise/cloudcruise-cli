---
name: cc-workflow-test
description: Test a handoff-ready CloudCruise workflow inside builder-agent dry-runs — queue payloads with the user at a confirmation gate, run each through to the end, investigate errors with the interact tool, fix the confident ones live and block the rest, and hand back an errors+fixes ledger. Use when a plan's build markers are all done.
---

# cc-workflow-test

Never fires a real backend run. Testing happens inside builder sessions, dry-run, driven by
the interact tool. Dry-runs still act on the real website — forms get filled and saved — so
nothing dispatches until the user approves the payload queue at the gate.

## The gate — queue payloads, get the go

Runs before any builder session is opened or reused. Assemble the candidate queue, present
it, wait for an explicit go.

Payload sources:

- **Example inputs** — the set the build left on the workflow (`--use-example-inputs`).
  Default first entry.
- **User-supplied** — JSON the user pastes or points at.
- **Agent-authored** — drafted or edited per `references/payload-guidance.md`.

Each entry is a file, `cc-workflows/<name>/payloads/<label>.json`, plus a label, source, and
one-line intent. Present to the user:

- workflow + version, environment, target site, credential the session will use, and that
  dry-runs act on the live site
- the queue: label · source · intent · distinguishing values
- **how to reset between payloads — ask, don't decide**: fresh task per payload, restore to a
  runnable point, or run against dirty state (findings discounted). Record the answer per entry.

The user edits, reorders, drops, adds. Any payload added later — mid-test included — goes back
through the gate. Never append silently.

## Sessions

If the plan header carries a live `conversation_id` (the build stage hands its session over
rather than ending it), reuse it for the first payload when that payload is the example set
the session already carries. For any other payload — and for every payload after the first —
end the current session, then load the payload into a fresh one keeping the logged-in browser:

```
builder edit --workflow <id> --input "$(cat cc-workflows/<name>/payloads/<label>.json)" \
  --use-last-browser-state --open-builder [vault flags from the plan header]
```

Clear `conversation_id` from the plan header when this stage ends the session.

## The loop

For each queued payload, in order:

1. **Load the payload** into a session (above) and apply the entry's reset answer.
2. **Dry-run to the end** in the builder session.
3. **On each error, investigate → fix or block** (below). Continue to the end.
4. **After any fix, verify** (below).
5. **Log the errors and their fixes** to the ledger under the payload's label.

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

- `cc-workflows/<name>/payloads/<label>.json` — every payload the gate approved, one file each.
- `cc-workflows/<name>/ledger.md` — errors + fixes, from `references/templates/test-audit.md`,
  keyed by payload label: per error, `where · what failed · root cause · fix · verification`,
  or `blocked: <what's needed>`.
- Rules discovered during testing (value constraints, null semantics, timing) codified back into
  the input_schema — never left as tribal knowledge.

## References

- `references/payload-guidance.md` — how to draft and edit agent-authored payloads.
- `references/track-branching.md` / `track-linear.md`.
- `references/input-schema.md` — the standard the build wrote; codify discovered rules back into it.
- `references/templates/test-audit.md`.
