---
name: cc-workflow-setup
description: Set up a new CloudCruise workflow build - declare kind (form or scrape), take the goal, gather config and credentials, explore the target site, and hand-author the component skeleton into a plan file the build stage consumes. Use after cc-workflow routes a new or stub workflow here.
---

# cc-workflow-setup — from intent to plan

Produces the plan file. Everything downstream (build loop, test) reads it; nothing
downstream re-asks what the plan already answers.

## Inputs

- Workflow name and the user's goal.
- Kind: `form` (writes data into the target site) or `scrape` (read-only extraction).
- Access to the target site — via a builder session for live exploration.
- Optional: a screen recording of a human doing the task (supplementary context, not
  a required step).

## Process

1. **Kind + goal intake.** Branch by kind:
   - `scrape` → ★ human gate, settled before anything else: the input key, the output
     fields, where the workflow stops. Everything outside that scope is out of scope
     and does not get documented.
   - `form` → light; the skeleton authoring below carries it.
2. **Stub on disk first.** Write the plan header (kind, goal, config keys) before any
   exploration — an interruption never loses the goal.
3. **Gather config.** Profile, workspace, `vault_user_id` + `vault_domain`, start URL.
   Ask only for keys the header is missing. Never ask for `workflow_id` — the build
   stage writes it after `builder start`.
4. **Explore and hand-author the skeleton.** Interact with the site (through a builder
   session) and/or watch the recording, then author into the plan:
   - the **component list** in order (pages/sections for a form; steps-to-the-data
     for a scrape) — this becomes the build loop's work list,
   - **scope**: what gets built and what explicitly does not,
   - **patterns**: interaction mechanisms, stated abstractly (→ patterns library),
   - **quirks**: portal behaviors that change how the build must be driven, each
     routed to its consumer (done-means invariant, driving rule, or residual note).
   Inventory (field lists, enum values) is NOT transcribed here — census gets it
   fresher at build time. Relations and structure are; inventory is not.
5. **Emit the plan** from the kind's template. Hand off to `cc-workflow-build`.

## Outputs

- `cc-workflows/<name>/plan.md` — header + skeleton with `[ ]` markers, per the
  kind's template.
- New/updated entries in `cc-workflows/patterns/` when a pattern was explicitly
  observed or stated.

## References

- `references/track-form.md` or `track-scrape.md` — the plan body
  contract for the declared kind.
- `references/templates/plan-form.md` / `plan-scrape.md`.
- `references/operating-rules.md`.

## Status

STUB — contract settled, body to be written.
