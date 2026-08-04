# Node ↔ input isomorphism (form track only)

One rule: **every node's name starts with the dotted schema path it serves.**

```
<dotted.schema.path> — <short human action>
```

Same string, four places: schema key, input template, `run_if.field`, node name.
Graph and schema become grep-searchable in both directions; coverage is checkable by
inspection (every schema leaf appears in at least one node name). Structural nodes
(save, nav, settle) use the page/section path alone.

Scrape workflows are exempt — small graphs, plainly descriptive names (tried and
dropped there; it bought nothing).

Enforcement: task messages instruct the builder to name nodes this way; the builder
won't always comply — do a cheap rename pass per checkpoint via direct edit (renames
are metadata-only and safe).

## Status

STUB — port the convention table + examples from the internal doc.
