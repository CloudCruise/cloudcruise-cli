---
name: cc-workflow
description: Entry point for building or resuming a CloudCruise workflow. Lists in-progress workflow plans and routes to the right lifecycle stage (setup, build, or test). Use when the user wants to start, continue, or check on a CloudCruise workflow build.
---

# cc-workflow — lifecycle entry

Router. Reads state, asks one question, hands off to a stage skill. Does no building.

## Inputs

- The artifact directory (`cc-workflows/` in the project root; create if absent).
- The user's intent: new workflow, or continue an existing one.

## Process

1. **Roster.** List `cc-workflows/*/plan.md` and print as a numbered list in reply
   text (never a select — the roster outgrows option caps). Stubs appear alongside
   live plans. User replies with a number or asks for a new workflow.
2. **Route on plan state:**
   - no plan / header-only stub → `cc-workflow-setup`
   - `skeleton_status: pending` or `rejected` → `cc-workflow-setup`, regardless of
     any markers already in the skeleton — an unaccepted skeleton never reaches build
   - `skeleton_status: accepted` and any `[ ]` / `[→]` markers → `cc-workflow-build`,
     resuming from the first unfinished component
   - `skeleton_status: accepted`, all `[x]`, test section absent or unfinished →
     `cc-workflow-test`
   - everything done → report status; ask nothing.
3. A resumed plan is never re-asked setup questions — the header already answered them.

## Outputs

- Control handed to a stage skill with the plan path.

## References

- The `cloudcruise` CLI skill for every command.

## Status

DONE.
