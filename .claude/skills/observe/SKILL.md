---
name: observe
description: Watch one in-progress CloudCruise builder turn to a verdict — poll builder status by exit code and, at higher tiers, digest builder messages for doom-loop / stall / context-poisoning / retry-pileup signals. Returns a verdict only (continue / done / answer / intervene) and never mutates the workflow, todos, or state. Forked child of builder-drive; never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Grep, Glob
---

# observe — tiered polling supervision, verdict only

You are a **fork** dispatched by `builder-drive` to **watch one builder turn** and return a
**verdict** — nothing else. You are read-only: never `send`, `respond`, `interrupt`, `save`, or
touch `todos.md`/the workflow. You observe and report; the orchestrator acts. Keep heavy
`builder messages` payloads inside this fork (that's why you exist) and return one short paragraph.

CLI syntax lives in `/cloudcruise`. Method only here.

## Arguments contract

`$ARGUMENTS`: `conversationId` (pin `--conversation "$CID"` on every command), `tier`
(`barrier` | `sampled` | `live`), `confirmed` (or a path to it — the states/pages already verified
done; your regression tripwire), `budgets` (`maxTicks`, poll interval), and `statePaths` (read-only;
for the plan/confirmed set). **Default the tier to `live` unless the orchestrator says the workflow
is clearly trivial** — the builder's expensive failures are silent.

## The watch loop (switch on the `builder status` exit code)

```bash
while :; do
  cloudcruise builder status --conversation "$CID"; code=$?    # exit code IS the state
  case $code in
    0) : "terminal → verdict: done (read stdout .status: completed|idle|ended)"; break ;;
    7) : "awaiting-human-input → verdict: answer (surface humanInput.messageId + prompt/fields)"; break ;;
    8) : "agent-errored → verdict: intervene (reason: agent error)"; break ;;
    9) : "processing → CHECK-IN TICK (below), then sleep + re-poll" ;;
    *) : "command-level failure (4 gone/5 ambiguous/6 busy/10 no-browser) → verdict: intervene"; break ;;
  esac
  # tick budget guard
done
```

`status` is also the keepalive, so polling keeps the session alive. If a command prints
`reconciledFrom`, the conversation was cleared and followed to its tip — note the new tip in your
verdict so the orchestrator updates `$CID`.

## Check-in tick by tier (on each `processing`, exit 9)

- **barrier** — do nothing but re-poll on a slow cadence; read only the eventual terminal status.
  Cheapest; for trivial workflows. No `builder messages`.
- **sampled** — each tick, pull a small window: `cloudcruise builder messages --limit 15
  --conversation "$CID"` (pagination envelope, base64 stripped) and run the heuristics below.
- **live** — same as sampled on a tighter cadence, with a larger `--limit` when a signal is
  forming, to confirm before you call `intervene`.

`builder messages` fields per message: `type` (action/reasoning/text/error/success/interaction),
`status`, `toolName`+`args`, `currentNodeId`/`nextNodeId`, and a per-message `history[]` retry
trail (`{timestamp,text,status}`).

## Heuristics (what a watching human notices)

- **Doom-loop** — the same `toolName`+hash(`args`) (or `+currentNodeId`) recurs **≥3×** with no
  intervening **progress event** (`workflow.updated` / `workflow.saved` / `new_variable.detected` /
  `execution.tool.success` / `finished_navigation`, or `nextNodeId` advancing). Progress resets the
  counter.
- **Stall** — no new `type:"action"` across ~2 ticks, or the latest message stuck
  `in_progress`/`processing` with no `history[]` movement.
- **Context-poisoning regression** — a tool's `args`/`currentNodeId` re-enters something already in
  `confirmed` (the classic "clicked through 15 pages, forgot 1–7, looped back"). This is the
  highest-value catch — the antidote (interrupt + re-inject the confirmed set) is the orchestrator's,
  but *you* detect it.
- **Retry pile-up** — one message's `history[]` accumulating status flips = an in-place mini-loop.
- **Budget breach** — `maxTicks` reached with the turn still processing.

The builder **self-limits server-side** (its own guardrails can interrupt it — that signal is *not*
exposed to you via `builder messages`, so compute these yourself). Because of that backstop, don't
be trigger-happy: at `barrier`/`sampled`, one clean progress event since the last tick means keep
watching.

## Verdict contract

Return **one short paragraph** — the only output:

- **verdict** — `done` (turn reached terminal; name which: completed/idle/ended) · `answer`
  (awaiting-human-input; include `humanInput.messageId` + the prompt/fields) · `intervene` (a
  heuristic tripped or an error/command-failure; name **which** heuristic, the offending
  `toolName`/`currentNodeId`/URL, and one evidence pointer) · `continue` (budget/`maxTicks`
  exhausted but nothing wrong — the orchestrator may re-dispatch observe).
- **tip** — the current conversation id if it reconciled.
- **note** — for `intervene`, the compact fact the orchestrator needs to re-scope or re-inject
  (e.g. "re-entered confirmed page 5 via CLICK on node abc; confirmed set holds pages 1–7").

Do not recommend the fix or edit anything — state what you saw. The orchestrator logs your verdict
to the audit log and decides help-vs-raise.
