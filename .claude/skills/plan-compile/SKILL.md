---
name: plan-compile
description: Compile a video-extract plan into the on-disk artifacts the builder-drive loop consumes — todos.md (ordered, ADR-referenced), an ADR directory, and a crude constraint-spec.md. Hosts the single ★ human gate of the pipeline (present the compiled artifacts for approval before the loop starts, unless --no-gate). Forked child; the gate itself is enacted by the inline caller. Never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# plan-compile — plan → todos + ADRs + constraint spec (the ★ gate)

You are a **fork**, the second pipeline stage. You turn a `video-extract` plan into the three
on-disk artifacts the `builder-drive` loop reads, then **return a review packet** the inline caller
uses to run the pipeline's **single human gate**. Formats are **deliberately crude for v0** — do not
gold-plate; they are markdown, no schema.

## Arguments contract

`$ARGUMENTS`: `planPath` (the `video-extract` output), `outDir` (where to write the artifacts;
default alongside the plan), and `--no-gate` (full-auto; skip the review-gate recommendation). Read
the plan; every section, branch, visual anchor, constraint, and the reset recipe carries forward.

## Compile the three artifacts

**1. ADR directory (`<outDir>/adrs/ADR-NNN.md`).** One file per candidate constraint from the plan
(narration + video only — no standing library). Crude:

```markdown
# ADR-007: <short title>
Context: <what the narrator said / the video showed that motivates this>
Decision: <the rule to hold — "always…", "never…", the valid value set>
Applies to: <section(s)/step(s)>
```

Number them stably; todos reference them by number.

**2. `todos.md`.** One ordered todo per plan section (split finer only when a section has clearly
independent sub-goals). Each todo carries everything `work`/`run-investigate` need — they read this
file, not your context:

```markdown
- [ ] 07 — <goal in plain language, NOT clicks>
      verb: map            # first-pass verb hint (map / test / harden); the loop adapts
      adrs: [7, 12]        # ADR numbers that bind this todo
      visual_anchor: <from the plan — run-investigate's registration point>
      branches: [ "<cond> → <arm A> | <arm B>", ... ]   # every branch to cover
      inputs: <the section's input inventory — fields + verbatim enum sets to fill>
      dependencies: [ "<parent>=<v> → <child> (revealed|required)", ... ]   # gating to honor
      reset_recipe: <ref/pointer to the plan's reset recipe>
      state: pending
```

Preserve plan order (login/entry first). Keep `state` in {pending, done, blocked}.

**3. `constraint-spec.md`** (crude markdown beside the ADRs). The constraints in a shape
`payload-gen` can later read to synthesize valid + contradictory inputs — field-level value rules,
required/forbidden combinations, enum sets. Distill it from three plan sources: the ADRs, the plan's
**input inventory** (each field's verbatim enum set → an allowed-values constraint; casing matters),
and the plan's **dependencies** (activation/requirement gating → the "present ⇒ child" combination
rules that make the best contradictory payloads). One line per constraint; note its source. It grows
during the build too (`work` appends constraints it discovers visually), so leave it append-friendly.

## The ★ human gate

The gate lives at this stage but **you cannot block for a human** (you're a non-interactive fork).
So: compile the artifacts, then **return a review packet**, and the **inline caller enacts the
gate** — presents the packet and waits for approval before invoking `builder-drive`. Unless
`--no-gate` (full-auto), the pipeline must not enter the loop until the human approves or edits the
artifacts on disk.

Your **review packet** (the return value) is:

- counts: sections/todos, ADRs, constraints, branches; whether a reset recipe was found.
- the todo list titles in order, and the ADR titles.
- anything that needs a human eye before building: ambiguous sections flagged by `video-extract`,
  branches with an unclear arm, constraints that look contradictory, a missing reset recipe.
- the artifact paths (`todos.md`, `adrs/`, `constraint-spec.md`).
- a one-line gate instruction: `GATE: review the artifacts at <paths>; approve to start builder-drive,
  or edit the files and re-confirm` (or, with `--no-gate`: `GATE SKIPPED (--no-gate) — proceeding`).

Keep it to a compact packet — the artifacts are on disk for the human to open; the return is the
summary + the flags that deserve attention.
