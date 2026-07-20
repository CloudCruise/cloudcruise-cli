---
name: builder-drive-legacy
description: Current-CLI (singleton-session) version of builder-drive, runnable today. Drive and supervise the CloudCruise builder agent through the CLI, agent-to-agent — own the plan/todo, dispatch atomic tasks (investigate/explore/map/test/fix/harden) to the builder, watch cheaply via bare poll, and intervene only when the builder doom-loops, poisons its own context, or rabbit-holes. Entry via a new workflow, an existing workflow (edit), or connecting to the local session. Use when the user wants Claude Code to build/edit a workflow by driving the builder on the current CLI.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill, AskUserQuestion
---

# builder-drive-legacy — supervising the builder agent on the current CLI

You are the **driver**: a higher-level agent that guides the CloudCruise **builder agent** the way
an attentive human would — dispatching work, watching, interrupting, re-focusing, and escalating,
but agent-driven. You own the plan and the todo; the builder executes one atomic task at a time.
Command syntax and the send/poll/respond mechanics live in `/cloudcruise`; this skill is
orchestration only.

This is the **current-CLI** variant: the builder session is an **implicit singleton** (no
`--session`), `poll` is single-shot, output is already JSON on stdout, and there is no
`sessions`/`stream`/`--open-builder`. One active session at a time.

## Core idea: spend almost all your time watching cheaply

The tension is real: don't slow down easy workflows, but catch the spiky long-tail before the
builder burns tokens or wedges. Resolve it with **graduated observation intensity** — start at the
cheapest tier and ramp only when signals warrant. An easy workflow completes at the cheapest tier
and never triggers heavy reasoning or a single user prompt.

| Tier | How you poll | When | Cost |
|---|---|---|---|
| **Barrier** | slow-cadence bare `poll`; read only `status` + final `text` | Easy workflows (the common case) | Cheapest — you ignore the tool stream |
| **Sampled** | normal-cadence `poll`; digest each poll's `tools`/`newMessageCount` for heuristics | Medium; check in each tick | Low |
| **Live** | fast-cadence `poll` (+ `builder messages --limit N` for depth) | Spiky/complex; tight detection | Highest |

Ramp up a tier on the first complexity signal (early budget pressure, a repeated tool call, a
regression into confirmed state). Ramp back down when it settles. The cadence knob is the sleep
interval between polls plus how much of each poll's `tools` array you digest.

## Entry points

The session is implicit — `builder start`/`edit` saves the `conversationId` locally and all later
builder commands use it automatically. **End the current session (`builder end`) before starting
another** — there is only one active session at a time.

- **New workflow:** `cloudcruise builder start --workspace-id <ws> --start-url <url> --name "<n>" [--vault-user-id <id> --vault-domain <domain>] [--proxy <s> --proxy-value <v>] [--input-schema <json> --input <json>] --no-open`
- **Existing workflow:** `cloudcruise builder edit --workflow <id> --workspace-id <ws> [--target-node <id>] [--use-last-browser-state] [--input <json>]`
- **Connect to a live session** (one already running, e.g. started in the frontend): the CLI has no
  session list, so re-attach by writing `~/.cloudcruise/session.json`:
  `{"conversationId":"<id>","baseUrl":"https://api.cloudcruise.com","workspaceId":"<ws>"}`, then
  confirm with `cloudcruise builder status` before dispatching.

After `start`, verify liveness (`builder status` active + a `builder screenshot`) before sending
the first instruction — a session can report `extensionConnected: false` and expire before any work.

## The dispatch loop (poll in a loop, switch on status)

Each dispatched task is one `builder send "<instruction>"` (returns immediately with
`status: sent`). Then poll in a loop and branch on the `status` field — `builder poll` returns
`{ status, text, tools, newMessageCount, totalMessageCount }`:

```
processing         → CHECK-IN TICK (heuristics below); sleep a few seconds; poll again
done               → evaluate result; advance plan / dispatch next task
waiting_for_input  → answer from plan (auto) | escalate per mode → respond → poll again
error              → INTERVENE (pull artifacts, diagnose → fix / re-scope / escalate)
idle               → no pending work; proceed / dispatch next task
```

`status` is the whole control signal for a live turn. **Never send the next message until you see a
terminal status (`done`/`error`/`idle`)** — sending mid-turn interrupts the agent. Command-level
failures (session expired, auth, bad flags) surface as a nonzero CLI exit on stderr, not a poll
status — handle them out-of-band. And the pathologies that matter most are invisible to `status`:
a builder that *loops without erroring* never returns `error` — those are caught only by your own
heuristics on the `processing` ticks.

**Answering `waiting_for_input`:** get the `messageId` from the poll (`waitingForInput` /
`waitingForInputs.inputs`), then `builder respond --message-id <id> --value "<v>"` (single) or
`--responses '<json>'` (multiple). For an `auth`-type input, respond with
`{ "<Alias>": { "permissioned_user_id": "<id>", "domain": "<domain>" } }` (look up via
`vault list`). If the agent records the answer but does **not** resume, re-send the same answer as
a chat message with `builder send`.

## Dispatch vocabulary — two families

These are *driver concepts* you compose into `builder send` instructions, each scoped and budgeted.
The family sets the iteration policy.

| Family | Verb | Instruction intent | Success check | Iterate? |
|---|---|---|---|---|
| **Discovery** (read-only) | `investigate` | Answer one narrow question / inspect one element or page | An answer | **No** |
| | `explore` | Bounded breadth discovery to map states/pages | A map/list | **No** — hard-capped; rabbit-hole zone |
| **Construction** (mutates workflow) | `map` | Turn confirmed understanding into nodes/edges | Nodes exist & coherent (`builder workflow`) | Yes, budgeted |
| | `test` | Run the built workflow and verify | `run start --wait` exit 0 + output shape matches | Yes, budgeted |
| | `fix` | Repair from a test diagnosis | Paired with `test` in a fix→test micro-loop | Yes, shared run budget |
| | `harden` | Convert execution types LLM_VISION→STATIC/XPath | Converted node still passes `test` | Yes, budgeted |

Discovery gets **no iteration** because it has no clean success signal — that is precisely where the
builder loops. Cap it, take back the result, and *you* decide whether to re-dispatch a **narrower**
discovery task or escalate. Never delegate "explore the whole site"; decompose it ("confirm only
whether page 8 has element X"). Construction iterates because success is checkable.

Follow `/cloudcruise`'s "describe the goal, not the clicks" rule for `investigate`/`explore`/`map` —
never dictate selectors or node structure. **`harden` is the one sanctioned exception**: it is an
explicit, opt-in execution-type pass, not build-time micromanagement.

Typical arc: `investigate/explore → map → test → (fix→test)* → harden → test → save`. Sequence
against your todo — an easy workflow is just `map → test → save`, no discovery/fix/harden.

**How `fix` works:** while the session is live, fix by sending the builder a corrective instruction
(feed it the diagnosis). Only fall back to direct DSL surgery (`snapshot suggest`/`test` +
`workflows update`) after the builder reaches a true terminal `error`/`done` — never fork the
workflow underneath a live builder turn.

## Detection heuristics (your own, layered on top of poll status)

Run these on each `processing` poll, digesting that poll's `tools`. They are what a watching human
notices:

- **Budget breach** — a discovery task exceeded its cap, or fix+test exhausted its run budget.
- **Doom-loop** — the same tool call / URL / node repeated ≥3× with no new artifact.
- **Context-poisoning regression** — the builder navigates back into a state it already reported
  confirmed. The classic "clicked through 15 pages, forgot pages 1–7, looped back." Detect via your
  confirmed-set (below); the antidote is interrupt + re-inject that set.
- **Stall** — no new tool calls across ~2 ticks, or repeated tool errors.

On any trip, ramp observation up a tier if not already there, then intervene.

## Intervention: help vs raise

When a heuristic trips or a poll returns `error`, ask two questions in order:

1. **Can I re-scope this into something the builder *can* do?** Split the task, narrow the target,
   or re-inject the confirmed-set. → **help**, stay agent-to-agent. For poisoning: `builder
   interrupt`, then `send` a compact restate — "You confirmed pages 1–7 (X,Y,Z). You are on page 8.
   Do not revisit 1–7. Next: page 9." You hold the memory it dropped.
2. If re-scoping won't help, **why is it stuck?** Route by archetype:
   - **long-for-agent / short-for-human** (the 15-page slog) → **raise** and offer **takeover**.
   - **confusing-for-agent / clear-for-human** (radio buttons that open sub-controls, mutually
     exclusive branches) → **raise** with a screenshot + the specific ambiguity; the human answers
     in a line and you re-dispatch an unambiguous `map`.

Every escalation carries a **fallback** so it works in both modes:
- **Interactive (default):** escalate via `AskUserQuestion` — situation (1 line) + one piece of
  evidence (screenshot/URL) + the specific unknown + 2–3 options. The branch blocks until answered.
- **`--autonomous`:** apply the fallback instead of asking — make the most reasonable choice and log
  it to the state file, or **park-and-flag** that branch and move on. Takeover-required escalations
  have no autonomous fallback, so in `--autonomous` they auto-convert to park-and-flag.

## Takeover

The builder and the human share the same live browser. Sequence, to avoid them fighting over the page:

1. `builder interrupt` to quiesce the builder; stop dispatching and polling for new work.
2. Hand the human the live session URL
   (`https://app.cloudcruise.com/workflows/builder/<conversationId>`) with an explicit ask:
   "click through these 5 pages and tell me which shows claim status."
3. Human signals done → re-read state (`builder screenshot`, `builder html`) → re-inject "here is
   where we are now" → resume the dispatch loop.

Never `send` while the human holds the turn — wait for a terminal poll status first.

## Driver state file (keyed by conversationId)

Keep a small state file (e.g. in your scratchpad) — it is your working memory across your own
context compaction, and its `confirmed` set *is* the re-injection payload for poisoning recovery:

```yaml
sessions:
  <conversationId>:            # one active session at a time on this CLI
    name: <session name>
    plan: []                   # ordered todo of (verb, scope)
    confirmed: []              # states/pages/facts the builder reported done
    budgets: {}                # per-verb spend
    escalations: []            # {situation, unknown, fallback, resolution}
    workflow: {id, version}
```

## Budgets (defaults; override via args)

- `explore` → hard cap ~10–15 page/snapshot actions, then mandatory report-back
- `investigate` → single dispatch
- `map` → up to 2 re-dispatches
- `fix`+`test` → **3 runs total** (build + 2 fixes), one shared counter
- `harden` → 1 pass + 1 verify `test`
- doom-loop trip → same call/URL/node ≥3× with no new artifact
- stall → no new tool call across ~2 ticks, or repeated tool errors

Overridable: `--explore-cap N`, `--run-budget N`, etc.

## Modes

- **Interactive (default):** a human is reachable; escalations go to them.
- **`--autonomous`:** the escalation sink swaps to fallback-or-park; never call `AskUserQuestion`,
  never block for direction. Same driver core, same verb loop.

## Load-bearing rules and gotchas (current CLI)

- **One active session at a time.** `~/.cloudcruise/session.json` is a global singleton; always
  `builder end` before starting the next session.
- **Never `send` into a live turn.** Gate sends on a terminal poll status (`done`/`error`/`idle`);
  if a turn is in progress, sleep and re-poll.
- **`respond` may not resume the agent** — if the poll stays `waiting`/idle after responding,
  re-send the same answer as a chat message via `builder send`.
- **`builder html` returns a JSON envelope** — parse `.html` out of it.
- **`builder status` / `builder workflow` can be ~1MB** — redirect to a file and parse with a
  script; never let them into context raw.
- **Verify the builder's claims at milestones** (`builder screenshot`, `builder html`) only in
  Sampled/Live tiers — trusting prose is fine on the easy path, cheap to verify when a signal trips.
- **HARD RULE — never `harden` a login-check `BOOL_CONDITION`** ("Is user logged in?"). Those run
  against arbitrary wake-up page state that no single XPath covers; they stay LLM_VISION by design.
