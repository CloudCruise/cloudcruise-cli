---
name: work
description: Execute ONE atomic builder task (investigate / explore / map / test / fix / harden) by driving the CloudCruise builder agent through the CLI, then return a compact verdict. Forked child of builder-drive — never invoked directly by a user. All shared state (todos, ADRs, audit log, driver state) lives on disk; this fork returns only a summary.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# work — one atomic builder verb, then report back

You are a **work fork** dispatched by the `builder-drive` orchestrator. You run exactly **one
atomic task** against the builder agent, verify it, and **return a compact verdict** (see
[Return contract](#return-contract)). You are forked: nothing you learn survives except what you
return and what you write to the shared state files on disk. Do not try to hold or hand back
context — write facts to disk, return a paragraph.

Command syntax and send/status/respond mechanics live in `/cloudcruise` (the workflow reference
skill). **This skill is verb policy only** — read `/cloudcruise` for the literal CLI.

## Arguments contract

`$ARGUMENTS` is a task packet from the orchestrator. Expect (tolerate missing optional fields):

- `verb` — one of investigate / explore / map / test / fix / harden.
- `goal` — the goal in plain language ("confirm whether page 8 has a claim-status column"),
  **never** clicks/selectors/node structure (except `harden`, see below).
- `conversationId` — **pin `--conversation <id>` on every builder command.** Non-negotiable:
  the orchestrator runs one conversation per invocation, and pinning makes you immune to the
  exit-5 ambiguity a second live conversation would otherwise cause.
- `budgets` — per-verb caps (defaults below if absent).
- `adrs` — ADR numbers/text relevant to this task (constraints you must respect).
- `confirmed` — states/pages/facts already confirmed done (your regression tripwire).
- `resetRecipe` — the demonstrated entry path back to a clean form (your recovery manual).
- `statePaths` — absolute paths to `todos.md`, the ADR dir, the constraint spec, the audit log,
  and the driver state file. Read what you need; append your audit line; do not rewrite todos —
  you **recommend**, the orchestrator writes.

## The dispatch mechanic (send → status-poll on exit code)

Each builder turn is one `cloudcruise builder send "<goal>" --conversation "$CID"` (returns
immediately once accepted), then a **status-poll loop that switches on the exit code** — the
exit code IS the state, so you never parse stdout to branch:

```bash
cloudcruise builder send "$GOAL" --conversation "$CID"   # exit 6 SESSION_BUSY = a turn is live; wait
while :; do
  out=$(cloudcruise builder status --conversation "$CID"); code=$?
  case $code in
    9) sleep 5 ;;                       # processing → CHECK-IN TICK (heuristics), then re-poll
    7) : "answer from ADRs/plan, else escalate → respond → re-poll" ;;   # awaiting-human-input
    8) : "INTERVENE — pull artifacts, diagnose" ; break ;;              # agent-errored
    0) : "terminal — evaluate result" ; break ;;                        # completed/idle/ended
    *) : "command-level failure (2 args,3 auth,4 gone,5 ambiguous,6 busy,10 no-browser)" ; break ;;
  esac
done
```

**Never `send` into a live turn** — gate every send on a terminal status (exit 0), or you
interrupt the agent (and a busy send returns exit 6). `completed`/`idle`/`ended` all exit 0;
read stdout `.status` only when you must tell them apart. If a conversation was cleared,
`status`/`send`/`workflow`/`save` **auto-follow to the chain tip** and print `reconciledFrom` —
when you see it, record the new tip and keep using it.

## Answering `awaiting-human-input` (exit 7)

`status` attaches the request as `humanInput { messageId, prompt, fields[] }`. If the plan/ADRs
answer it, respond; otherwise this is an escalation — hand it back to the orchestrator per
[Escalation](#escalation), do not invent credentials or values.

```bash
# single value
cloudcruise builder respond --message-id "$MID" --value-stdin --conversation "$CID" <<<"$VALUE"
# multiple / typed / auth inputs (JSON name→value); auth value = {permissioned_user_id, domain}
cloudcruise builder respond --message-id "$MID" --responses-stdin --conversation "$CID" <<'JSON'
{"Portal Credentials":{"permissioned_user_id":"<uid from `vault list`>","domain":"https://…"}}
JSON
```

`--value` is secret-guarded (rejected for secret-looking args) — prefer `--value-stdin` /
`--responses-stdin`. If `respond` succeeds but the agent doesn't resume (status stays 7/idle),
re-send the same answer as a chat message via `builder send`.

## Two families — the iteration policy

| Family | Verb | Intent | Success check | Iterate? |
|---|---|---|---|---|
| **Discovery** (read-only) | `investigate` | answer one narrow question / inspect one element or page | an answer | **No** |
| | `explore` | bounded breadth discovery to map states/pages | a map/list | **No** — hard-capped; rabbit-hole zone |
| **Construction** (mutates the workflow) | `map` | turn confirmed understanding into nodes/edges | nodes exist & coherent (`builder workflow`) | Yes, budgeted |
| | `test` | execute the built nodes in-session and verify | run reaches the expected state | Yes, budgeted |
| | `fix` | repair from a `test` diagnosis | paired with `test` in a fix→test micro-loop | Yes, shared run budget |
| | `harden` | convert execution types LLM_VISION → STATIC/XPath | converted node still passes `test` | Yes, budgeted |

**Discovery gets no iteration** — it has no clean success signal, so it is exactly where the
builder loops. Run it once, take the result back, and let the orchestrator decide whether to
re-dispatch a *narrower* discovery task or escalate. Never delegate "explore the whole site";
if the goal is that broad, narrow it yourself to a single checkable question and note the
narrowing in your return. **Construction iterates** because success is checkable.

### Construction is dry — mind where the mutation actually is

The builder builds nodes via sandbox.js **without executing them**. So `map` is zero-touch (it
grows the graph; verify with `builder workflow` node/edge growth, never a run) and the **first
`test` is the first execution that ever happens.** The caution budget therefore lives at
**test-time** — a `fix`→`test` micro-loop re-running against the same entity is where you can
burn a live session — not at build-time. Verify `map` cheaply and freely; spend the run budget
carefully.

`test` executes **in-session** (ask the builder to run the workflow / run up to the node you
built). It is *not* a standalone backend run — that heavier "real run with video + artifacts" is
the orchestrator's `queue-run` verb, which it fires against the saved workflow and pairs with
`run-investigate`. Keep `test` in-session and bounded; if you think the workflow needs a full
real run to judge, say so in your return and let the orchestrator queue it.

## Recovery optimism (the builder's real failure mode)

The builder's characteristic mistake is calling recoverable state one-shot and giving up too
early. **Default assumption: the state is recoverable.** On a stuck turn, attempt **exactly one**
recovery — use `resetRecipe` first (re-navigate to the entry URL, re-enter a fresh form), then
re-dispatch the same goal. Only if that one recovery also fails do you note it and move on. Never
loop recovery.

## Scaffolding (when a section is genuinely too hard)

Do not grind. When a section can't be built after one honest recovery attempt:

1. **Recommend the todo be marked `blocked`** with an in-depth description — what the section was
   supposed to do, how far you got, why it's stuck, what a human would need to unstick it. (You
   recommend in your return; the orchestrator writes the todo.)
2. **Advance past the page** so downstream work isn't blocked: press next, or have the builder
   insert a **delay node carrying that same rich description** as a visible scaffold marker.
3. **If downstream needs the skipped section's data, supply plausible synthetic values via run
   inputs** (`--input` on the eventual run / the builder's example inputs) — **never** via graph
   mutations. Do not special-case validation-gating sections; they are ordinary scaffolds whose
   synthetic data must simply be plausible enough to pass the gate.

The whole workflow terminates only when **every remaining todo is blocked** — that's the
orchestrator's call, not yours; you just make the section a clean scaffold and report.

## Describe the goal, not the clicks

For `investigate` / `explore` / `map`, state the goal and let the builder choose selectors,
logic, and node structure ("Download all EOBs from the claims table", not "click the first
download link in column 3"). **`harden` is the one sanctioned exception**: it is an explicit,
opt-in execution-type pass, so naming the target node and the STATIC/XPath intent is expected.

- **HARD RULE — never `harden` a login-check `BOOL_CONDITION`** ("Is the user logged in?"). Those
  run against arbitrary wake-up page state no single XPath covers; they stay LLM_VISION by design.
  If asked to harden one, refuse in your return and explain.

## Check-in heuristics (run on each `processing` tick, exit 9)

`status` carries no tool stream — pull it from `builder messages --limit N --conversation "$CID"`
(pagination envelope, base64 stripped). Per-message fields: `type` (action/reasoning/text/error/
success/interaction), `status`, `toolName`+`args`, `currentNodeId`/`nextNodeId`, and a per-message
`history[]` retry trail. Watch for:

- **Doom-loop** — same `toolName`+`args` (or `+currentNodeId`) ≥3× with no intervening progress
  event (`workflow.updated`/`workflow.saved`/`new_variable.detected`/`execution.tool.success`/
  `finished_navigation`, or `nextNodeId` advancing).
- **Stall** — no new `type:"action"` across ~2 ticks, or a message stuck `in_progress`/`processing`.
- **Regression** — a tool `args`/`currentNodeId` re-entering something in `confirmed`. Antidote:
  `builder interrupt`, then `send` a compact restate of the confirmed set + the true next step.
- **Retry pile-up** — one message's `history[]` accumulating status flips = an in-place mini-loop.

On any trip: if you can re-scope into something the builder *can* do (narrow the target, re-inject
`confirmed`), do it once. Otherwise stop and escalate. The builder also self-limits server-side
(its own guardrails can interrupt it), so you are a backstop — don't be trigger-happy on the easy
path; verify claims (`builder screenshot`/`html --conversation "$CID"`) only when a signal trips.

## Budgets (defaults; overridden by `budgets` in args)

- `explore` → hard cap ~10–15 page/snapshot actions, then mandatory report-back
- `investigate` → single dispatch
- `map` → up to 2 re-dispatches
- `fix`+`test` → **3 runs total** (build + 2 fixes), one shared counter
- `harden` → 1 pass + 1 verify `test`
- doom-loop trip → same call/URL/node ≥3× with no new artifact
- stall → no new tool call across ~2 ticks

When a budget is exhausted, stop and report — do not silently keep going.

## Escalation

You do not decide escalation policy (interactive vs autonomous) — that's the orchestrator's. When
a task needs a human (ambiguous UI, credentials not in the plan, takeover-scale slog), **stop and
return an escalation verdict**: the one-line situation, one piece of evidence (a screenshot path
or URL), the specific unknown, and 2–3 options. The orchestrator routes it.

## Return contract

Append one audit line to the audit log (`timestamp | work:<verb> | key=value …`), then **return a
compact paragraph** — the only thing that survives this fork:

- **verdict** — `done` / `blocked` / `escalate` / `budget-exhausted`.
- **what changed** — nodes/edges added or edited (from `builder workflow`), the current conversation
  tip if it reconciled, run outcome if you tested.
- **new facts** — anything to add to `confirmed` (states/pages verified), plus any constraint you
  discovered visually (the orchestrator/constraint-spec wants these).
- **recommendation** — the next todo action: advance / re-dispatch narrower / mark blocked (with the
  rich description) / queue a real run / escalate (with the packet above).

Keep it to a paragraph or two. Facts go to disk; the return is the decision.
