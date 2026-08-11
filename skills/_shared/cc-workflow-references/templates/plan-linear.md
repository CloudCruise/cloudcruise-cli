---
complexity: linear     # branching | linear — derived from the drafted skeleton
profile: ""            # CLI auth profile; pass --profile on every command
workspace_id: ""
vault_user_id: ""
vault_domain: ""
start_url: ""
workflow_id: ""        # written by the build session after builder start — never asked
conversation_id: ""    # written at builder start, cleared at builder end
goal: ""               # what the workflow does and where it stops — settled at intake
skeleton_status: pending   # pending | accepted | rejected — set by setup's confirm gate
---

# <Workflow name> — build plan

## Goal

What the workflow does and where it stops. (From intake, not exploration.)

## Steps

<!-- one line per move toward the goal, in order; [ ] / [→] / [x] markers -->

- [ ] step 1 …
- [ ] step 2 …

## Data

Which screen holds it, which fields matter.

## Open

<!-- census questions for the build session — never asked of the human -->
