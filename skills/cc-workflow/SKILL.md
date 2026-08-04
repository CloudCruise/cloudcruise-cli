---
name: cc-workflow
description: Entry point for building or resuming a CloudCruise workflow. Lists in-progress workflow plans, scans for reusable workflows/components/credentials, and routes to the right lifecycle stage (setup, build, or test). Use when the user wants to start, continue, or check on a CloudCruise workflow build.
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
2. **Reuse scan** (new workflows only). Before creating anything, check what already
   exists for this domain: `cloudcruise workflows list`, `cloudcruise components list`,
   `cloudcruise vault list`. An existing workflow to fork, component to reuse, or
   credential to bind can eliminate whole stages. Report findings before proceeding.
3. **Route on plan state:**
   - no plan / header-only stub → `cc-workflow-setup`
   - any `[ ]` / `[→]` markers in the skeleton → `cc-workflow-build`, resuming from
     the first unfinished component
   - all `[x]`, test section absent or unfinished → `cc-workflow-test`
   - everything done → report status; ask nothing.
4. A resumed plan is never re-asked setup questions — the header already answered them.

## Outputs

- Control handed to a stage skill with the plan path.

## References

- `references/operating-rules.md` — always.
- The `cloudcruise` CLI skill for every command.

## Status

STUB — contract settled, body to be written.
