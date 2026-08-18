---
name: cc-workflow-dispatch
description: Dispatch two or more discrete CloudCruise workflow requests to separate parallel subagents while keeping the current thread as the user's single manager chat. Use when the user asks to start, resume, build, or test several workflows at once, including requests that supply multiple plans, recordings, screenshots, or Loom links.
---

# cc-workflow-dispatch — parallel workflow manager

Coordinate only. Give each workflow to its own worker; let the existing
`cc-workflow` lifecycle skill and its setup, build, and test stages do the work.

## Dispatch

1. Split the request by discrete workflow, not by recording, lifecycle stage, or
   implementation step. Context for the same workflow stays with one worker.
2. Resolve enough ambiguity to identify each workflow. Do not inspect recordings,
   choose build details, or repeat intake that the lifecycle skills own.
3. Spawn one **named, implementation-capable general-purpose worker** per workflow.
   Do not use a read-only explore or plan worker. Use a host-safe form of the
   workflow slug as its stable name. Never put two workers on the same workflow.
4. In every spawn prompt include only that workflow's:
   - requested outcome and lifecycle intent (`start`, `resume`, `build`, or `test`)
   - plan path or workflow name, when known
   - recordings, screenshots, Loom links, and user notes
   - instruction to invoke `cc-workflow` and follow the stage skill it routes to
   - instruction to work autonomously until complete or genuinely blocked
5. Start independent workers concurrently up to the host's available limit. Keep
   pending workflows in request order and start the next whenever a slot opens.

## Messages

The parent thread is the only user-facing manager. A worker must not open a
separate user decision loop.

- **Up:** Tell every worker to message the parent immediately when it needs user
  input, using `NEEDS_INPUT: <question>` followed by the relevant context, viable
  choices, and its recommendation. If live parent messaging is unavailable, the
  worker returns that block as its result.
- **Down:** Ask the user in this thread, then send the answer to the requesting
  worker. Message a running worker; follow up with or resume an idle/completed
  worker. Preserve the same worker rather than spawning a replacement.
- Permission and approval prompts surfaced by the host remain attributed to their
  worker; relay only business or workflow decisions yourself.
- Ordinary progress stays in the worker thread. Bring only blockers, completions,
  and failures into the manager thread.

After dispatch, wait for worker messages and results. Do not perform workflow work
in the manager while waiting. Continue until every requested workflow is complete,
failed with a concrete reason, or blocked on a question already presented to the
user.

## Completion

Return one compact roster containing each workflow's state and outcome. Preserve
the worker's artifact paths, workflow IDs, test disposition, and unresolved risks;
do not reproduce its full transcript.
