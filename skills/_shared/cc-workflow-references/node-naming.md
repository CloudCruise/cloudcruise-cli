# Node ↔ input isomorphism (branching track only)

One rule: **every node's name starts with the dotted schema path it serves.**

```
<dotted.schema.path> — <short human action>
```

Same string, four places: schema key, input template, `run_if.field`, node name.
Graph and schema become grep-searchable in both directions. Structural nodes
(save, nav, settle) use the page/section path alone.

Linear workflows are exempt — small graphs, where isomorphic naming buys nothing
over plainly descriptive names. This tracks `complexity`: a branching read-only
workflow still gets isomorphic names; a linear one that writes still doesn't need
them.

Enforcement: task messages instruct the builder to name nodes this way; the builder
won't always comply — do a cheap rename pass per checkpoint via direct edit (renames
are metadata-only and safe).

## Worked example

The schema key `demographics.properties.visit_information.properties.visit_start_time`
becomes the node `demographics.visit_information.visit_start_time — enter Visit
Start Time`, which also appears verbatim as the `run_if.field` on every node it
gates. Same string, three of the four places at once — the fourth (input template)
reads `{{context.inputs.demographics.visit_information.visit_start_time}}`.

Structural node, page-path-alone per the exemption above:
`patient_history — nav from demographics`.

## Status

DONE.
