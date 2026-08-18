# Patterns library — <domain / form family>

Catalog of interaction mechanisms, shared across every workflow on this form family.

Rules:
- **Explicit statements only** — an entry is written when the mechanism was
  demonstrated/announced or stated by the user, never inferred from static structure.
- **One entry per mechanism**, not per section or form; cosmetic differences are a
  variants note.
- **Write-back is mandatory** — when a build investigates an unmatched component, the
  resolved pattern lands here before the component is built.
- No section→pattern assignments live here; matching happens at build time against
  the live DOM.

## Entry template

```markdown
## <pattern-name (kebab-case)>

- **Source:** <where it was stated/demonstrated>
- **Recognize:** structural signature in the DOM
- **Fill:** the interaction contract (order, guards, timing, traps)
- **Schema shape:** which input-schema construct this maps to
- **Variants:** known cosmetic differences, if any
```
