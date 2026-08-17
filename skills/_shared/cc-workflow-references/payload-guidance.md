# Payload guidance

How to hand-craft input payloads for the test queue — client-side, from the workflow's
`input_schema`. Companion to `input-schema.md` (the authoring standard; this file is the
consuming side).

## Start from the example set

The example input set is a proven-live payload — it ran the workflow during build. For a
targeted scenario, copy it and mutate. Write from scratch only when the scenario is far from
it (a null-tier payload, where nearly every value changes anyway).

Mutation rule: when you flip a controller, immediately apply the on/off values its rules
demand for every downstream target. Never flip and leave — a filled target whose trigger is
off is invalid.

## The payload contract

- A valid payload has exactly the schema's keys: `additionalProperties: false` at every
  level, every field `required`. Nothing omitted, nothing extra.
- "Doesn't apply" is an off value, never an absent key: `null` for hidden scalars/objects
  (recursively null for nested objects, per the `$defs/hidden` sentinel), `[]` for hidden
  multi-selects, or the forced constant the rule states.
- Vault aliases are required fields. In a payload file, the value is the literal placeholder
  string `<alias>` (e.g. `"login": "<login>"`). Never null an alias; never invent a
  credential value. The real credential binds at session creation — `--vault-user-id` +
  `--vault-domain`, or `builder edit --input '{"<alias>": "<permissioned_user_id>"}'` for
  multi-credential workflows.

## The envelope

Envelope = vault aliases + every field the workflow consumes to *reach* its task —
navigation, search, record selection. The schema does not mark these; a field can be
schema-nullable yet mandatory to get anywhere.

Envelope values stay pinned to the example set's values in every tier. "Null tier" means all
task content off — not all fields null. When unsure whether a field is envelope, keep the
example value.

## Reveal rules — controllers first, targets second

Conditionals live in `allOf` as `if/then/else`:

- `if.properties.<controller>` carries one of two predicate shapes: `{const: X}` (scalar
  equals) or `{contains: {const: X}}` (multi-select includes X). Multiple properties in one
  `if` AND together.
- `else.properties.<target>` states the off value when the trigger doesn't hold:
  `$ref: #/$defs/hidden` → null, `maxItems: 0` → `[]`, `const` → that constant.
- `then.properties.<target>` gives the revealed shape. `then.allOf` nests further rules
  whose predicates conjoin with the parent's.

Procedure: choose every controller value first, targets second. For each gated field, walk
its rules in order — the first rule whose predicates fail dictates the off value; only if
every rule's predicates hold, generate a real value from the `then` schema.

## Multi-select exclusivity

A field-level rule of the shape `if: {contains: {const: "None of the above"}}, then:
{maxItems: 1}` marks a singleton option. Pick the singleton alone, or any subset of the
non-singleton options — never mixed.

## Value selection

- Prefer the schema's `example` when present.
- Test candidates against `pattern` for real — run the regex, don't eyeball it.
- Nullability: `"null"` in the type array, or `null` in the enum.
- Keep arrays at 0–2 items unless breadth is the point of the payload.

## Tiers

Name payloads by tier; the queue's intent field carries the bias.

- **null** (`null.json`) — every controller set to a value that triggers nothing, all gated
  fields off, nullable leaves null, envelope pinned. Tests the workflow's skip paths.
- **max** (`max.json`) — controllers set to whichever value reveals the most, all
  non-singleton options selected, everything filled. Tests the deepest path.
- **partial** (`partial-<bias>.json`) — mixed choices biased toward the branch under test
  ("reveal wound care, leave nutrition minimal"). This is where hand-crafting earns its
  place: the bias expresses intent.

A null payload minimizes reveals; it cannot always reach zero — a boolean controller whose
both values trigger something has no quiet setting. Don't chase an impossible all-off
payload.

## Validate before queueing

Every payload validates clean before it enters the queue, regardless of source:

```bash
cloudcruise workflows validate-input <workflow_id> --file payloads/partial-woundcare.json
```

Exit codes: `0` valid · `1` payload invalid (structured per-field errors on stdout — repair
and re-run until clean) · `2` schema does not compile (fix the schema, not the payload;
`then: {required: [...]}` is the known killer — see `input-schema.md`).

It validates against the *saved* schema — push schema edits (`workflows update`) before
validating against them. `<alias>` placeholders pass validation.

Do not probe other endpoints as validators: `run start` fires a real run when the payload is
valid, and builder session creation validates shape-only (`required` stripped), so it accepts
payloads a run would reject.

## When to stop

- A conditional idiom outside the shapes above (a predicate that isn't `const` or
  `contains.const`; an `else` that isn't hidden / `maxItems: 0` / `const`): don't guess.
  Report the idiom and stop.
- Exit 2 from validate-input: the schema is broken. Report it; no payload can fix it.
