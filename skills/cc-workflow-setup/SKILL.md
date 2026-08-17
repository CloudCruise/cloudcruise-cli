---
name: cc-workflow-setup
description: Set up a new CloudCruise workflow build - take the goal, gather config and credentials, and hand-author the skeleton (branching components or linear steps) into a plan file the build stage consumes. Use after cc-workflow routes a new or stub workflow here.
---

# cc-workflow-setup — from intent to plan

Produces the plan file. Everything downstream (build loop, test) reads it; nothing
downstream re-asks what the plan already answers.

## Inputs

- Workflow name and the user's goal — specific enough to state its own scope and
  stopping point; nothing else gets asked separately.
- Context to build the skeleton from — one or more of: a typed/pasted description,
  screenshots, a screen recording. Gathered explicitly at step 3, not assumed.

## Process

1. **Goal intake.** Take the goal and the name.
   Slugify the name silently for the `cc-workflows/<slug>/` directory.
2. **Stub on disk first.** Write the plan header (goal, config keys) before any
   exploration — an interruption never loses the goal.
3. **Gather config.** Profile, workspace, `vault_user_id` + `vault_domain`, start URL.
   Ask only for keys the header is missing. Never ask for `workflow_id` — the build
   stage writes it after `builder start`.
4. **Gather context, draft the skeleton, confirm.** Ask the user which of typed
   description / screenshots / screen recording they want to give — one or several,
   combined is fine. Infer the extraction mode — strict steps vs the shape of the
   path to the goal — from what they hand over; don't ask. See the matching
   `references/input-*.md` for how each modality maps in under that mode.
   Draft skeleton content in whichever shape the gathered context actually
   calls for — flat ordered steps per `track-linear.md`, or goal-oriented
   components at the granularity `track-branching.md` pins down — and set
   `complexity` to match what got drafted; both `complexity` and the extraction
   mode are observed, not asked. Present the draft back and record the outcome as
   `skeleton_status` in the plan header:
   - **Accept** → `accepted`, proceed to step 5.
   - **Amend** → redraft with the feedback (including a wrong `complexity` call —
     that's an amendment like any other), present again — loop until accepted or
     rejected.
   - **Reject** → `rejected`, stop. This is persisted state, not a retry; a human
     revisits it later.
   A user who states they want auto-accept skips presenting the draft — mark
   `accepted` and proceed straight to step 5.
5. **Emit the plan** from the `complexity`'s template, only once
   `skeleton_status: accepted`. Hand off to `cc-workflow-build`.

Don't infer the starting state from the gathered context. A recording almost always
begins already logged in and already inside the target, so a skeleton drafted from
it opens mid-journey and silently omits everything before the first frame. The
skeleton starts where a cold run starts, not where the recording does; build
confirms the real entry state on the live page and amends if they differ.

## Outputs

- `cc-workflows/<name>/plan.md` — header (`complexity`, `skeleton_status`) +
  skeleton with `[ ]` markers, per the `complexity`'s template.
- New/updated entries in `cc-workflows/patterns/` when a pattern was explicitly
  observed or stated.

## References

- `references/track-branching.md` or `references/track-linear.md` — the plan body
  contract for the drafted `complexity`.
- `references/templates/plan-branching.md` or `references/templates/plan-linear.md`.
- `references/input-text.md`, `references/input-screenshots.md`,
  `references/input-recording.md` — how each gather modality maps into the
  skeleton, under the declared extraction mode.
