# Input-schema standard

The contract every form build follows. North star: **the schema alone is a complete
build contract, and every valid payload is a witness of a legal form state** — the
form is reconstructable from payload inspection alone.

## Scope (to be written — re-grounded on the Axxess RN SOC v23 schema)

The standard covers, with the platform's actual AJV config as ground truth:

1. Object shape: pages → sections → fields; orchestration scalars at top level.
2. Enums: complete, verbatim, case-exact; nullable enum leaves carry a trailing
   `null` member.
3. Required + absence: every key required. Absence values by type — `null` for
   scalars, `[]` for arrays (arrays are NOT nullable: loops don't skip on null,
   empty arrays loop zero times), the recursive `hidden` definition for revealed
   composites (`null` | empty array | object of all-hidden). Empty string is never
   an absence value.
4. Reveal encoding, bidirectional: forward `if trigger then typed else hidden`,
   backward `if not hidden then trigger present`. Trigger algebra: `contains const`
   for checkbox-group membership, `const true` for booleans, `anyOf` + `minItems`
   for any-of triggers, `maxItems` for exclusive "none" options.
5. `run_if` runtime guards mirroring the schema's gating (`IS_NOT_NULL` skip-if-empty,
   `EQUAL`/`CONTAINS` for conditional sub-fields).
6. Per-leaf `description` (on-form label, reveal provenance in prose) and `example`
   (real accepted value; `null` example on commonly-hidden fields).
7. `additionalProperties: false` everywhere; anchored `pattern` for formatted strings.
8. Validator facts (draft-07, `allErrors:false`, `strictRequired` throws at compile —
   never `then.required`, narrow types instead).

## Status

STUB — distill from the internal standard doc + the live v23 reference schema.
Everything listed above is settled; the write-up is pending.
