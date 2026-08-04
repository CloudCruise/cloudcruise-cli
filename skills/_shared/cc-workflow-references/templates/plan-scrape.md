---
kind: scrape
profile: ""            # CLI auth profile; pass --profile on every command
workspace_id: ""
vault_user_id: ""
vault_domain: ""
start_url: ""
workflow_id: ""        # written by the build session after builder start — never asked
conversation_id: ""    # written at builder start, cleared at builder end
goal: ""               # input key · output fields · where it stops — settled at intake
---

# <Workflow name> — build plan

## Goal

Input key · output fields · where it stops. (From intake, not exploration.)

## Steps

<!-- one line per move toward the data, in order; [ ] / [→] / [x] markers -->

- [ ] step 1 …
- [ ] step 2 …

## Data

Which screen holds it · which fields are the output.

## Open

<!-- census questions for the build session — never asked of the human -->
