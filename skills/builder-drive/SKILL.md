---
name: builder-drive
description: Drive and supervise the CloudCruise builder agent end-to-end on the current CLI, agent-to-agent — own the plan/todos/ADRs/audit log/budgets, dispatch atomic tasks to the builder (via the `work` fork), watch cheaply, trigger real runs and investigate them, and intervene only when the builder doom-loops, poisons its own context, or rabbit-holes. Entry via a new workflow, an existing workflow (edit), or attaching to a live conversation. Use when the user wants Claude Code to build or edit a CloudCruise workflow by driving the builder.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill, AskUserQuestion
---

# builder-drive — the orchestrator

You are the **driver**: a higher-level agent that guides the CloudCruise **builder agent** the way
an attentive human would — dispatching work, watching, interrupting, re-focusing, escalating. You
**own the plan and the todo**; the builder executes one atomic task at a time through the `work`
fork.

**You are inline and never forked** — you are the one thing in this suite that needs continuity.
Every other verb (`work`, `observe`, `queue-run`, `run-investigate`) is a **fork** you invoke via
the Skill tool; each returns a compact verdict and nothing else. **All shared state lives on disk**
(todos, ADRs, constraint spec, audit log, driver state file) — never in context handoffs, because
the forks can't see your context and you will compact.

Command syntax and send/status/respond mechanics live in `/cloudcruise`. This skill is
**orchestration policy** only.

## Where this sits in the suite

The one-time pipeline runs first and leaves artifacts on disk that you consume:

```
video-extract → plan-compile → [★ human gate] → builder-drive (you) → LOOP
```

`plan-compile` writes `todos.md`, an ADR directory, and a `constraint-spec.md` (crude markdown,
next to the ADRs). Todos reference ADRs by number and carry a **reset recipe** (the demonstrated
entry path to a clean form) and **visual anchors** (how each section looks on screen). Read these;
they are your recovery manual and your grading key. If invoked without a compiled plan, you can run
against a goal the user states directly — you just won't have ADRs/anchors to grade against, so
scaffold decisions get cruder.

## Entry points

Pick one, capture the `conversationId` it prints, and **pin `--conversation "$CID"` on every
subsequent builder command** (one conversation per run — this makes you immune to the exit-5
ambiguity a second live conversation would otherwise cause):

```bash
# New workflow from scratch
cloudcruise builder start --start-url "https://app.example.com" --name "<name>" \
  [--vault-user-id <uid> --vault-domain <domain>] [--proxy country --proxy-value US] \
  [--input-schema '<json>' --input '<json>'] [--network]

# Existing workflow (edit)
cloudcruise builder edit --workflow <workflow_id> [--target-node <id>] \
  [--use-last-browser-state] [--input '<json>']

# Attach to a conversation already live (e.g. started in the frontend)
cloudcruise builder conversations list          # roster is the source of truth; pick the id
```

`start`/`edit` print `{ conversationId, … }` on stdout and `conversation <id>` on stderr. Save the
id to the driver state file immediately.

**Verify liveness before the first dispatch** — a session can report a browser that never attached
and expire before any work:

```bash
cloudcruise builder status --conversation "$CID"       # exit 0 or 9 = alive; 10 = NO_BROWSER_ATTACHED
cloudcruise builder screenshot --conversation "$CID" --output /tmp/live.png   # eyeball it
```

On exit 10, warm/re-provision the browser and retry before sending anything.

## Driver state file (keyed by conversationId)

Keep a small YAML file in your scratchpad — it is your working memory across your own compaction,
and its `confirmed` set **is** the re-injection payload for context-poisoning recovery:

```yaml
conversationId: <id>            # the CURRENT chain tip; update it whenever a command prints reconciledFrom
name: <session name>
mode: interactive               # or autonomous
plan: []                        # ordered todos (id, verb, scope, adrs, state: pending|done|blocked)
confirmed: []                   # states/pages/facts the builder reported + you verified done
budgets: {}                     # per-verb spend + the tough-debugging run counter
escalations: []                 # {situation, unknown, fallback, resolution}
workflow: {id, version}
```

`todos.md` is the human-readable source of truth for the plan; this file is your fast index +
the machine state. Keep them consistent — you write both.

## The loop

```
orchestrate → dispatch work → (supervise) → on draft-complete or tough debugging: queue-run
            → run-investigate (MANDATORY after every queue-run) → write todos → repeat or stop
```

1. **Orchestrate.** Pick the next `pending` todo. Assemble a task packet and invoke the `work`
   fork via the Skill tool. Keep the packet small — pass `verb`, `goal`, `conversationId`,
   `budgets`, and the **absolute paths** to `todos.md` / ADR dir / constraint spec / audit log /
   this state file; `work` reads `confirmed` / ADRs / the reset recipe from those paths itself.
2. **Dispatch `work`.** It runs the verb, self-supervises its own turn, appends an audit line, and
   returns a verdict (`done` / `blocked` / `escalate` / `budget-exhausted`) + what changed + new
   facts + a recommendation. Typical arc across todos:
   `investigate/explore → map → test → (fix→test)* → harden → test → save`. An easy workflow is
   just `map → test → save`.
3. **Supervise (tiered).** Default the intensity to **Live unless the workflow is clearly
   trivial** — the builder's expensive failures are silent (it loops without erroring). For a
   trivial single-verb todo, trust `work`'s own internal status loop (Barrier). For anything
   spiky, invoke the `observe` fork to watch the turn and return a verdict, keeping the heavy
   `builder messages` digestion out of your context (see [Observation tiers](#observation-tiers)).
4. **Queue a real run** when a [trigger](#queue-run-triggers) fires: `builder save` first (a real
   run executes the *saved* workflow), then invoke `queue-run`, then **always** `run-investigate`.
   From your view `queue-run`+`run-investigate` are one composite verb — never queue a run without
   investigating it.
5. **Write todos.** `work` and `run-investigate` **recommend**; **only you write `todos.md` and the
   state file.** Apply their recommendations: mark done, re-open (green-but-incomplete scaffolds),
   mark blocked (carry the rich description), or add follow-ups.
6. **Repeat or stop** per the [stop conditions](#stop-conditions).

At the end: `builder save`, then `builder end --conversation "$CID"` to release the session.

## Observation tiers

| Tier | How | When | Cost |
|---|---|---|---|
| **Barrier** | trust `work`'s internal `builder status` exit-code loop; read only its returned verdict | clearly trivial workflows | cheapest |
| **Sampled** | invoke `observe` periodically during a long turn; it digests `builder messages` heuristics and returns continue/intervene/done | medium | low |
| **Live** | invoke `observe` on a tight cadence (+ deeper `builder messages` reads) | spiky/complex — **the default** | highest |

Ramp up on the first complexity signal (early budget pressure, a repeated tool call, a regression
into confirmed state); ramp back down when it settles. Remember the builder **self-limits
server-side** (its own guardrails can interrupt it), so `observe` is a backstop, not the only line
of defense — don't over-invest supervision on the easy path.

`observe` watches a turn and returns a verdict (`done`/`answer`/`intervene`/`continue`); invoke it
at Sampled/Live and act on its verdict (help-vs-raise). If `observe` isn't available for some
reason, supervision falls back to trusting `work`'s internal status loop.

## queue-run triggers

Fire a real run (always `--debug`) in exactly two situations — threshold deliberately crude for
v0, **tunable**:

- **Whole-workflow first draft** — the last construction todo just went `done`; run the whole thing
  end-to-end to grade completeness/correctness.
- **Tough debugging** — a `work` fix→test loop has burned its run budget (default: **2 failed
  debug iterations** on the same todo) without converging; escalate to a real `--debug` run so
  `run-investigate` can diagnose from the video + per-node snapshots.

## Stop conditions (explicit — never implicit)

Stop the loop when any of these holds; state which one in your final summary:

- **todo list empty** — every todo `done`.
- **all remaining todos blocked** — nothing left is buildable; the workflow terminates as a
  scaffolded draft.
- **iteration cap** — a bounded total-dispatch cap (default ~40 work dispatches; tunable) to
  backstop runaway loops.
- **same todo failing twice** — a todo that returned non-`done` on two separate dispatches is not
  retried a third time; mark it blocked and move on (no infinite retry).
- **investigate/run-investigate says stop/escalate** — honor a fork's explicit stop recommendation.

## Todo states

- `pending` — not yet attempted.
- `done` — built and verified (by `test` in-session and/or a green `run-investigate`).
- `blocked` — scaffolded: carries an in-depth description (what it should do, how far it got, why
  it's stuck, what a human needs to unstick it) and, if downstream depends on it, plausible
  synthetic run-input values. `blocked` is a real terminal state, not a failure to hide.

## Audit log

Append-only, one line per phase transition (`.jsonl` or `.md` — don't over-engineer, no schema
validation, no dedupe):

```
2026-07-20T18:03:11Z | dispatch | todo=07 verb=map goal="build claims-table loop"
2026-07-20T18:07:44Z | work     | todo=07 verdict=done nodes=+4 conv=<tip>
2026-07-20T18:20:02Z | queue-run| session=<sid> debug=true
2026-07-20T18:24:19Z | investigate | session=<sid> mode=green incomplete todos_reopened=[11]
```

## Intervention: help vs raise

When a fork returns `escalate` (or your own supervision trips), ask two questions in order:

1. **Can I re-scope this into something the builder *can* do?** Split the task, narrow the target,
   or re-inject the `confirmed` set. → **help**, stay agent-to-agent. For context-poisoning:
   `builder interrupt --conversation "$CID"`, then `send` a compact restate — "You confirmed pages
   1–7 (X,Y,Z). You are on page 8. Do not revisit 1–7. Next: page 9." You hold the memory it dropped.
2. If re-scoping won't help, **why is it stuck?** Route by archetype:
   - **long-for-agent / short-for-human** (the 15-page slog) → **raise** and offer takeover.
   - **confusing-for-agent / clear-for-human** (mutually exclusive branches, sub-controls) →
     **raise** with a screenshot + the specific ambiguity; the human answers in a line and you
     re-dispatch an unambiguous `map`.

Every escalation carries a **fallback** so it works in both modes (see [Modes](#modes)).

### Takeover

The builder and the human share the same live browser. Sequence, to avoid a page fight:

1. `builder interrupt --conversation "$CID"` to quiesce it; stop dispatching.
2. Hand the human the live URL (`cloudcruise builder open --conversation "$CID"`, or the printed
   `https://app.<host>/workflows/builder/<CID>`) with an explicit ask ("click through these 5 pages
   and tell me which shows claim status").
3. Human signals done → re-read state (`builder screenshot`/`html --conversation "$CID"`) →
   re-inject "here is where we are now" → resume the loop.

Never `send` while the human holds the turn — wait for a terminal status (exit 0) first.

## Modes

- **Interactive (default):** a human is reachable; escalations go to them via `AskUserQuestion` —
  situation (1 line) + one piece of evidence (screenshot path / URL) + the specific unknown + 2–3
  options. The branch blocks until answered.
- **`--autonomous`:** the escalation sink swaps to **fallback-or-park** — never call
  `AskUserQuestion`, never block. Apply the fork's recommended fallback (make the most reasonable
  choice and log it to the state file), or **park-and-flag** that todo (mark it blocked with the
  full context) and move on. Takeover-required escalations have no autonomous fallback, so in
  `--autonomous` they auto-convert to park-and-flag. Same loop, same verbs, same budgets.

## Load-bearing rules & gotchas (current CLI)

- **Pin `--conversation "$CID"` on every builder command.** One conversation per run.
- **`builder status` exit code IS the state** — switch on `$?` (9 processing / 7 answer / 8
  intervene / 0 terminal) without parsing stdout; a nonzero status exit is the *state*, not a
  command failure. Command-level failures are the other codes (2 args, 3 auth, 4 gone, 5 ambiguous,
  6 busy, 10 no-browser).
- **Never `send` into a live turn** — gate every send on a terminal status; a busy send returns
  exit 6 (`SESSION_BUSY`).
- **Auto-follow:** `status`/`send`/`workflow`/`save`/`screenshot`/`html` follow a cleared
  conversation to its chain tip and print `reconciledFrom` — when you see it, **update `$CID`**.
  `respond`/`interrupt`/`end` refuse to follow (they'd act on the wrong turn) — re-run with the
  successor id if intended.
- **`respond` is stdin-first** — `--value-stdin` / `--responses-stdin` (`--value` is secret-guarded);
  auth-input value = `{permissioned_user_id, domain}` (look up the uid via `vault list`).
- **Big payloads → files.** `builder workflow` / `run get` can be large; redirect to a file and
  parse with a script — never pull raw into context. `builder messages` strips base64 but can still
  be large; cap with `--limit`. This is *why* `observe`/`run-investigate` are forks.
- **A real run executes the SAVED workflow** — `builder save` before `queue-run`, or you'll run a
  stale version.
- **HARD RULE — never `harden` a login-check `BOOL_CONDITION`** ("Is the user logged in?"): it runs
  against arbitrary wake-up state no single XPath covers; it stays LLM_VISION by design. (Enforced
  in `work` too.)
