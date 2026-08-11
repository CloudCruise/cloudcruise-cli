# Input-schema standard

The contract every form build follows. North star: **the schema alone is a complete
build contract, and every valid payload is a witness of a legal form state** — the
form is reconstructable from payload inspection alone.

## Scope

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

## Worked example

The `cardiac_status.cardiac_assessment` subtree — trimmed to two of its reveal
pairs, enough to hit most of the rules above in one place.

**1. Object shape.** `cardiac_status` is a page, `cardiac_assessment` a section
within it, nested under the top-level object alongside orchestration scalars like
`task_date`.

**2. Enums**, complete and verbatim, including the trailing colon that's part of
the on-form text:
```json
"findings": {"type": "array", "items": {"enum": ["No problems identified",
  "Activity intolerance", "Abnormal pulses:", "Chest pain:", "..."]}}
```
Nullable single-select, trailing `null`:
```json
"quality": {"enum": ["Burning", "Dull", "Pressure", "Sharp", null]}
```

**3. Required + absence.** The recursive `hidden` definition, unchanged wherever a
revealed composite appears in the schema:
```json
"hidden": {"anyOf": [{"type": "null"},
                      {"type": "array", "maxItems": 0},
                      {"type": "object", "additionalProperties": {"$ref": "#/definitions/hidden"}}]}
```

**4. Reveal encoding, bidirectional.** Forward — `findings` containing
`"Abnormal pulses:"` reveals two detail fields, else they're hidden:
```json
{"if": {"required": ["findings"],
        "properties": {"findings": {"contains": {"const": "Abnormal pulses:"}}}},
 "else": {"properties": {"abnormal_pulses_type": {"$ref": "#/definitions/hidden"},
                          "abnormal_pulses_location": {"$ref": "#/definitions/hidden"}}},
 "then": {"properties": {"abnormal_pulses_type": {"type": "string"},
                          "abnormal_pulses_location": {"type": "string"}}}}
```
Backward — the converse of the same relationship:
```json
{"if": {"required": ["abnormal_pulses_type"],
        "properties": {"abnormal_pulses_type": {"not": {"$ref": "#/definitions/hidden"}}}},
 "then": {"properties": {"findings": {"contains": {"const": "Abnormal pulses:"}}}}}
```
Exclusive "none" option, via `maxItems`:
```json
{"if": {"contains": {"const": "No problems identified"}}, "then": {"maxItems": 1}}
```

**5. `run_if` guards mirror the schema.** A node entering an unconditional field
carries `IS_NOT_NULL` on its own path (from elsewhere in the same schema, the node
`demographics.visit_information.visit_start_time — enter Visit Start Time`):
```json
{"match": "all", "conditions": [{"field":
  "context.inputs.demographics.visit_information.visit_start_time",
  "operator": "IS_NOT_NULL"}]}
```
A node revealed by a checkbox-group member carries `CONTAINS` on the group's path
(node `supportive_assistance.safety_measures.presence_of_animals — enter description`):
```json
{"field": "context.inputs.supportive_assistance.safety_measures.measures",
 "value": "Presence of animals:", "operator": "CONTAINS"}
```

**6. Per-leaf `description`/`example`.** A `null` example on a commonly-hidden
field documents *why* it's usually null, not just that it can be:
```json
"aicd": {"type": "object", "example": null,
         "description": "Revealed when findings contains 'AICD:'."}
```

**7. `additionalProperties: false` + `pattern`.** Every object in the subtree
closes with `additionalProperties: false`; every date field anchors
`"pattern": "^\\d{2}/\\d{2}/\\d{4}$"`.

**8. Validator facts** aren't visible in any schema excerpt — they're compile-time
AJV config, not schema content. What *is* checkable from the schema itself: this
schema has zero `then.required` anywhere, consistent with the `strictRequired`
compile-crash rule above.

## Status

DONE.
