---
name: payload-gen
description: Generate test payloads for a CloudCruise workflow from its CONSTRAINT SPEC (not its input_schema) — valid-and-varied payloads that should pass, plus deliberately contradictory ones that violate a named constraint and should fail. Quality-phase forked child of the builder-drive pipeline. Complements payload-sweep (which is input_schema-driven / mechanical). Never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# payload-gen — constraint-spec → valid-varied + contradictory payloads

You are a **fork** in the quality phase. You read the **constraint spec** (the semantic rules the
narration + the build discovered — "always…", "never…", required combinations, valid value sets)
and generate two payload families: **valid-and-varied** (satisfy every constraint, should pass) and
**deliberately contradictory** (violate one named constraint, should fail). You write them to disk
with an expected-outcome manifest and **return a short summary**.

## payload-gen vs payload-sweep — don't confuse them

| | source | intent |
|---|---|---|
| **payload-sweep** (exists) | `input_schema` | mechanical: full/empty/partial tiers to prove null-safety + schema coherence |
| **payload-gen** (this) | **`constraint-spec.md`** | semantic: does the workflow honor the *narrated/discovered constraints* |

They complement each other. Use `input_schema` here **only for payload shape** (field names,
nesting, types); the *values and combinations* come from the constraint spec.

## Arguments contract

`$ARGUMENTS`: `constraintSpecPath` (the `plan-compile` / build-updated spec), `workflowId` (for the
`input_schema` shape via `cloudcruise workflows get`), `outDir`, and optional counts (`validN`
default ~4, `contradictoryN` default one per falsifiable constraint). The credential key + any
scaffold synthetic values follow the same rules as a real run (see `queue-run`).

## Generate

1. **Read the constraint spec.** Each entry is a rule with the field(s)/section it binds and the
   ADR it came from. Classify each as *falsifiable* (you can construct a payload that violates it —
   mutual exclusion, required-combination, enum membership, value bound) or *non-falsifiable at the
   input layer* (a UI-behavior rule with no input knob — note it, skip it for contradictory gen).

2. **Valid-and-varied** (`validN` payloads, all `expect: pass`). Every one satisfies **every**
   constraint, but they spread across the valid space — different enum picks, different valid
   combinations, boundary-but-legal values, present/absent optional sections. The point is variety
   within legality, not a single happy path.

3. **Contradictory** (one per falsifiable constraint, `expect: fail`). Each violates **exactly one**
   named constraint (hold everything else valid so the failure is attributable): set two
   mutually-exclusive options together, break a required "present ⇒ children" combination, use an
   out-of-set enum value, exceed a stated bound. Tag each with the constraint id it breaks.

4. **Propose freely.** If while generating you find a constraint the spec is missing (a value set a
   node clearly expects, an implied exclusion), **append it to `constraint-spec.md`** — no
   ratification ceremony; the spec is meant to grow from what you discover.

## Output contract (write to `outDir`)

- `payloads/valid_NN.json`, `payloads/contradictory_NN.json` — runnable run-input JSON (include the
  credential key).
- `manifest.json` — one row per payload: `{file, kind: valid|contradictory, expect: pass|fail,
  violates: <constraint id or null>, note}`. This is what tells the grader what *should* happen.

**Return a short summary**: counts (valid / contradictory), which constraints got a contradictory
case and which were skipped as non-falsifiable, any constraints you appended to the spec, and the
`outDir`. Do not run the payloads — the orchestrator runs them via `queue-run` (or `run start`) and
grades pass/fail against your manifest with `run-investigate` / the `payload-sweep` classifier. A
valid payload that fails, or a contradictory one that passes, is the finding.
