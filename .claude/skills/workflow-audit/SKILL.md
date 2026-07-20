---
name: workflow-audit
description: Lint a CloudCruise workflow DSL for quality issues — categorical free-string inputs that should be enums (casing has bitten us), delay-node scaffolds missing rich descriptions, LLM_VISION nodes eligible for hardening to STATIC (never login-check BOOL_CONDITIONs), and loose/ungrouped nodes. Read-only; recommends, never edits. Quality-phase forked child of the builder-drive pipeline. Never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Grep, Glob
---

# workflow-audit — lint the workflow DSL

You are a **fork** in the quality phase. You pull a workflow's DSL, run four lint passes, and
**return a findings list** — you **recommend, never edit** (fixes go through `work`/`workflows
update`, the orchestrator's call). DSL syntax + node reference live in `/cloudcruise` and
`references/workflow-dsl.md`.

## Arguments contract

`$ARGUMENTS`: `workflowId` (pull via `cloudcruise workflows get <id>`) **or** `conversationId` (pull
the live graph via `cloudcruise builder workflow --conversation <id>`), plus `statePaths`
(constraint spec / plan, for the enum pass) and a `scratchDir`.

```bash
cloudcruise workflows get "$WF" > "$scratchDir/workflow.json"   # can be large — to a file
```

Parse `nodes`, `edges`, `input_schema`. Never pull the raw JSON into your return.

## The four lint passes

**1. Categorical free strings → enums.** In `input_schema`, find string fields whose real value set
is a small fixed list (values referenced verbatim by nodes — selectors, `comparison_value_*`,
templates — or listed in the constraint spec) but typed as a bare `"string"` with no `enum`.
Recommend converting to `enum`. **Enum casing has bitten us before** — the enum values must match,
character-for-character, what the nodes/selectors compare against; flag any casing/whitespace
mismatch between a proposed enum value and its consuming node. (Ref: red-link schema-enum work — every
template/option list discovered should become an enum on its input variable.)

**2. Harden-eligible LLM_VISION nodes.** Find nodes with `execution: "LLM_VISION"` whose target is a
stable, uniquely-selectable element (a labeled button/field/select on a consistent page) — those are
candidates to convert to `STATIC` XPath (`snapshot suggest`/`test` to confirm uniqueness). Recommend
`harden`. **HARD EXCLUSION — never flag a login-check `BOOL_CONDITION`** ("Is the user logged in?")
or any BOOL_CONDITION that runs against arbitrary wake-up page state: no single XPath covers it; it
stays LLM_VISION by design. Skip these silently — do not even list them as candidates.

**3. Delay-node scaffolds missing rich descriptions.** Find `DELAY` nodes (`action: "DELAY"`) whose
`description` is empty or thin. A scaffold delay (inserted by `work` when a section was skipped)
**must** carry an in-depth description of what the section should do and why it was skipped — a bare
delay is an undocumented hole. Flag each. Also note where a `DELAY` could be replaced by `wait_time`
on the adjacent action node (the DSL prefers that over standalone delays).

**4. Loose / ungrouped nodes.** Grouping means **component membership** — `BaseNode` has no
`group`/`section` field; the grouping primitive is the component (`source_component_instance_id`).
Flag runs of nodes not associated with any component where the plan or repetition shows they'd be a
reusable group (a repeated section, a login flow), and recommend extracting them into a component.

## Return contract

Append one audit line (`timestamp | audit | wf=<id> findings=<n>`), then **return a findings list** —
grouped by pass, most-actionable first. Each finding: `{pass, node_id-or-field, what, recommendation,
confidence}`. Be specific (name the node/field and the concrete fix) so the orchestrator can turn a
finding straight into a `work` `fix`/`harden` todo or a direct `workflows update`. No raw DSL in the
return; the findings are the value.
