---
kind: form
profile: ""            # CLI auth profile; pass --profile on every command
workspace_id: ""
vault_user_id: ""
vault_domain: ""
start_url: ""
workflow_id: ""        # written by the build session after builder start — never asked
conversation_id: ""    # written at builder start, cleared at builder end
goal: ""
---

# <Workflow name> — build plan

## Scope

What gets built. What explicitly does not.

## Skeleton

<!-- pages in order; components per page; [ ] / [→] / [x] markers.
     Per component: goal, done-means invariant, narrated rules near-verbatim.
     Inventory is census-pending — never transcribed as truth. -->

- [ ] page_one
  - [ ] page_one.component_a — <goal>. Done-means: <invariant>.
  - [ ] page_one.component_b — …

## Quirks

<!-- portal behaviors that change how the build is driven; each routed to its
     consumer: done-means, driving rule, or residual builder note -->

## Reset

<!-- what a test run dirties and how a human undoes it -->

## Open

<!-- census questions for the build session — never asked of the human -->
