---
complexity: branching  # branching | linear — derived from the drafted skeleton
profile: ""            # CLI auth profile; pass --profile on every command
workspace_id: ""
vault_user_id: ""
vault_domain: ""
start_url: ""
workflow_id: ""        # written by the build session after builder start — never asked
conversation_id: ""    # written at builder start, cleared at builder end
goal: ""               # what the workflow does, what's in/out of scope, where it stops
skeleton_status: pending   # pending | accepted | rejected — set by setup's confirm gate
---

# <Workflow name> — build plan

## Skeleton

<!-- pages in order; components per page; [ ] / [→] / [x] markers.
     Per component: goal, done-means invariant, narrated rules near-verbatim.
     Inventory is census-pending — never transcribed as truth. -->

- [ ] page_one
  - [ ] page_one.component_a — <goal>. Done-means: <invariant>.
  - [ ] page_one.component_b — …

### Worked example (illustrative — not a template to fill in)

- [x] cardiac_status
  - [x] cardiac_status.cardiac_assessment — fill the findings checklist and every
        field each finding reveals. Done-means: `findings` matches the on-form
        selections; every revealed detail field is filled; nothing revealed-but-empty.
  - [→] cardiac_status.chest_pain — fill quality/location/duration, gated on
        `findings` containing `"Chest pain:"`. Done-means: fields present only when
        gated in; `quality` is one of Burning/Dull/Pressure/Sharp.
  - [ ] cardiac_status.vital_signs — …

## Open

<!-- census questions for the build session — never asked of the human -->
