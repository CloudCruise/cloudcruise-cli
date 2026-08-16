# Builder task messages

The shape of one message to the builder agent. A task is the unit of dispatch: one
component (or one exploration), one builder turn, one verifiable outcome.

## Anatomy (settled)

1. **Goal** — what must be true when done. Outcome, not procedure.
2. **Location** — page/section by on-form name.
3. **Inputs** — known (exact `context.inputs.…` paths from the schema slice) or
   to-discover (exploration is a first-class task, not a failure to prepare one).
4. **Status skeleton** — compact whole-build progress block so the builder knows
   where this task sits. Never the full plan, other components' details, or history.
5. **Conventions** — inputs via `{{context.inputs.…}}` never literals; `run_if`
   gating stated as data; node naming per the naming reference; the pattern contract
   if the component matched one.

## Rules (settled)

- Goal, not clicks. Never selectors, execution types, or node structure.
- State required actions directly. Use conditional phrasing only when evaluating
  that condition is itself part of the workflow behavior.
- One component per task; "and then" means split.
- **A task that explores carries the literal token `/interact`.** That token, and
  nothing else, arms the builder's `interact` tool — describing exploration in prose
  does not. Unarmed, the builder falls back to authoring and deleting a throwaway
  node per probe, silently. Arming lasts the conversation but lapses after an idle
  hour, so put it in the first explore message and again after any long gap; a
  repeat is free.
- Text only — the builder's page access beats any image.
- Exact paths verbatim; a paraphrased path wires the wrong variable silently.
- Default completion: a debug execution succeeds. Spell out extras only for unusual
  components.

## The schema block

A task that registers or extends `input_schema` carries the conventions with it.
They live in `input-schema.md`, but a builder composing a slice does not re-derive
them from the standard unprompted — it produces something reasonable-looking and
locally wrong, and the divergence only surfaces when a payload is rejected at run
start. Prefer registering new inputs beneath the consuming component's dotted path.
Restating the conventions costs five lines per message:

> **Schema conventions:** scalar leaves a `run_if IS_NOT_NULL` can skip are typed
> `["<type>","null"]` — null is the absence value, empty string never is. Every key
> appears in its object's `required`, at every level. `additionalProperties: false`
> on every object. Anchored `pattern` on formatted strings, matching your own
> examples. Never `required` inside a `then` — narrow types in `then.properties`
> instead. Every object using `contains` carries a sibling `"type": "array"`.

This is the default, not a law. A component whose shape genuinely wants something
else — a leaf that must never be null, an object that legitimately takes unknown
keys — diverges deliberately and **says so in the task message**, so the difference
reads as a decision rather than an oversight. What the block prevents is the silent
kind: a slice that diverges because nobody stated the default.

After the component executes, component creation is a separate builder task: “Create a reusable
component named <name> from the nodes built for <plan component>.” Do not treat
`saveWorkflow` as component creation.

## Worked example: branching track

Component `cardiac_status.cardiac_assessment`:

> **Goal:** Fill the Cardiac Assessment findings checklist and every field each
> selected finding reveals. Done: `findings` matches the on-form selections; each
> revealed detail field is filled; nothing left revealed-but-empty.
>
> **Location:** Cardiac Status page, Cardiac Assessment section.
>
> **Inputs:**
> - `context.inputs.cardiac_status.cardiac_assessment.findings` (array, known)
> - `context.inputs.cardiac_status.cardiac_assessment.abnormal_pulses_type`,
>   `.abnormal_pulses_location` — revealed when `findings` contains
>   `"Abnormal pulses:"` (paths known; to-discover: whether the location field is
>   free text or a fixed-option select — confirm live)
> - `context.inputs.cardiac_status.cardiac_assessment.chest_pain.quality` —
>   revealed when `findings` contains `"Chest pain:"` (path and enum both known)
>
> **Status:** page 6 of 14 (Cardiac Status) · 2 of 9 components on this page ·
> 41 of 63 overall.
>
> **Conventions:** inputs via `{{context.inputs...}}`, never literals. `run_if`
> gates every reveal-dependent node on `findings` per the schema's `contains` rule.
> Node names: `cardiac_status.cardiac_assessment.findings — check findings`,
> `cardiac_status.cardiac_assessment.abnormal_pulses_type — enter type`.

## Worked example: linear track with input variables (illustrative)

Plain navigation and clicks:

> "navigate to the benefits claim lookup page" · "click search" · "click save"

A first touch on a new input variable names it once, with its shape:

> "enter the claim ID into the claim number field — register a new input variable
> `context.inputs.claim_id` (string, example `CLM-2049123`)"
>
> "enter the caller's phone number — register `context.inputs.caller_phone` (string,
> example `312-555-0142`)"

A locally-resolved decision point stays inside one message:

> "if no claim is found, click save-as-not-found and end; otherwise continue to the
> follow-up note"

A later reference to an already-registered variable names it back, verbatim, and
says explicitly that it isn't new:

> "the follow-up note field should read 'Callback confirmed for ' followed by the
> existing `context.inputs.caller_phone` — don't register a second phone variable"

Drop that last clause and "the caller's phone number from before" resolves fine in
a human's memory but isn't a path — the builder can't distinguish "the thing three
steps back" from "a new field that happens to sound similar," and it'll either mint
a stray `phone_number` variable while `caller_phone` sits unused, or the reverse.

Output uses the linear track's fixed convention, so the message only needs to name
the fields, not the mechanism:

> "extract the claim status and confirmation number, the standard way" — "the
> standard way" is `track-linear.md`'s fixed screenshot-plus-extract-datamodel pair.

## Status

DONE.
