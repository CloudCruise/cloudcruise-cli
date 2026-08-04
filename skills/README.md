# CloudCruise workflow lifecycle — skill family

Skills that take a CloudCruise workflow through its full lifecycle: entry → setup →
build → test. Ships with `cloudcruise install --skills` alongside the `cloudcruise`
CLI skill, which it depends on and never duplicates.

## Layout

```
skills/
├── cloudcruise/              platform: CLI command reference (standalone skill)
├── cloudcruise-workflow-dsl/ platform: workflow DSL reference (standalone skill)
├── cc-workflow/              entry: roster, reuse scan, resume-or-new, route by plan state
├── cc-workflow-setup/        kind + goal intake, config, hand-authored skeleton → plan
├── cc-workflow-build/        per-component loop: explore → schema → implement → execute once
├── cc-workflow-test/         form: hardening loop · scrape: acceptance gate
└── _shared/cc-workflow-references/   family contracts, owned by no single skill
    ├── input-schema.md           the input-schema standard
    ├── task-messages.md          shape of one message to the builder agent
    ├── node-naming.md            node name = dotted schema path (form track)
    ├── operating-rules.md        safety + driving discipline, cross-stage
    ├── track-form.md             form-track contracts (plan body, spine, verify)
    ├── track-scrape.md           scrape-track contracts
    └── templates/                artifact templates (plan headers, patterns, audit)
```

A pack is any top-level `skills/` dir with a `SKILL.md`; `install --skills` copies
each to `.claude/skills/<name>/`. The four `cc-workflow*` packs carry
`references -> ../_shared/cc-workflow-references` symlinks; the installer
materializes them into real files per pack. npm strips symlinks from tarballs, so
each pack also declares `sharedReferences` in its `skill.meta.json` sidecar and the
installer falls back to copying from `_shared/` — both paths are covered.

Install stamps a `.cloudcruise-skill.json` manifest per pack; `src/core/skills.ts`
warns on gated commands (builder/run/workflows) when installed skills drift from the
CLI version (exit 11 refuse mode available via `GATE_MODE`).

## Design rules

1. **Skills own control flow; references own contracts.** Track (form|scrape) is data
   in the plan header — skills branch on it and load the track contract; no track
   logic interleaved in skill prose.
2. **Exact about contracts, invariants, and formats; loose about procedure.** Hard
   constraints go in artifacts (schema, plan format, templates), not instructions.
   The builder agent is driven with goals, never clicks/selectors/node structure.
3. **State is derived, never indexed.** The roster is the artifact directory listing;
   the plan file is the only per-workflow state. No registry file.
4. **The mutation axis governs test.** Write workflows (form) get the hardening loop,
   execute-once discipline, and a reset story. Read workflows (scrape) run freely
   against oracle pairs.

## Artifact directory (consumer project state, not shipped)

```
cc-workflows/                  (name tentative)
├── <workflow-name>/
│   ├── plan.md                config header + skeleton + status markers — THE state
│   ├── payloads/              test payloads, each with expected outcome
│   └── audit.md               test runs: payload → result → disposition
└── patterns/                  interaction-pattern library, per form family
```

## Status

Scaffold. Every SKILL.md and reference carries its contract (purpose, inputs,
outputs, references read); bodies get filled stage by stage. Cursor target
(`install --skills --target cursor`) does not yet map this family — TODO.
