# CloudCruise workflow lifecycle — skill family

Skills that take a CloudCruise workflow through its full lifecycle: entry → setup →
build → test. Ships with `cloudcruise install --skills` alongside the `cloudcruise`
CLI skill, which it depends on and never duplicates.

## Layout

```
skills/
├── cloudcruise/              platform: CLI command reference (standalone skill)
├── cloudcruise-workflow-dsl/ platform: workflow DSL reference (standalone skill)
├── cc-workflow/              entry: roster, resume-or-new, route by plan state
├── cc-workflow-setup/        goal intake, config, gather → draft skeleton
│                             (derives complexity) → confirm → plan
├── cc-workflow-build/        per-component loop: explore → schema → implement → execute once
├── cc-workflow-test/         one dry-run loop: generate → dry-run → disposition →
│                             grade on completion
└── _shared/cc-workflow-references/   family contracts, owned by no single skill
    ├── input-schema.md           the input-schema standard
    ├── task-messages.md          shape of one message to the builder agent
    ├── node-naming.md            node name = dotted schema path (branching track)
    ├── track-branching.md        branching-track contracts (plan body, spine, verify)
    ├── track-linear.md           linear-track contracts
    ├── input-text.md, input-screenshots.md, input-recording.md
    │                             per-modality mapping into the skeleton, under
    │                             the declared extraction mode
    └── templates/                artifact templates (plan headers, patterns, audit)
```

A pack is any top-level `skills/` dir with a `SKILL.md`; `install --skills` copies
each to a target's skills root (`.claude/skills/<name>/`, `.cursor/skills/<name>/`,
or `.agents/skills/<name>/` per `--target`). The packs are pure text — no scripts,
no bundled deps. Anything the lifecycle skills need at runtime is a `cloudcruise`
CLI command (`builder await-turn`, `workflows gen-payloads`), so a pack ports to
every agent runtime and OS with no interpreter concerns. The four `cc-workflow*`
packs carry `references -> ../_shared/cc-workflow-references` symlinks; the installer
materializes them into real files per pack. npm strips symlinks from tarballs, so
each pack also declares `sharedReferences` in its `skill.meta.json` sidecar and the
installer falls back to copying from `_shared/` — both paths are covered.

Install stamps a `.cloudcruise-skill.json` manifest per pack; `src/core/skills.ts`
warns on gated commands (builder/run/workflows) when installed skills drift from the
CLI version (exit 11 refuse mode available via `GATE_MODE`). Lifecycle packs that
call the new commands set `requiresCli` in their sidecar so a too-old CLI is caught.

## Design rules

1. **Skills own control flow; references own contracts.** `complexity`
   (branching|linear) is data in the plan header — skills branch on it and load the
   matching track contract; no track logic interleaved in skill prose.
2. **Exact about contracts, invariants, and formats; loose about procedure.** Hard
   constraints go in artifacts (schema, plan format, templates), not instructions.
   The builder agent is driven with goals, never clicks/selectors/node structure.
3. **State is derived, never indexed.** The roster is the artifact directory listing;
   the plan file is the only per-workflow state. No registry file.
4. **`complexity` governs structure.** Observed from the drafted skeleton, not
   asked — it decides skeleton shape, node-naming's applicability, reveal-encoding
   depth, and how much explore/hardening work is worth doing. A linear workflow
   that writes and a branching one that only reads are both real, independent
   cases. A goal specific enough to state its own scope and stopping point is
   sufficient at intake; "did the workflow complete" is the grading bar.

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

`cc-workflow` and `cc-workflow-setup` are done. The plan header carries
`complexity` — the axis that's load-bearing for skeleton shape, node-naming, and
reveal depth. `cc-workflow-build` and `cc-workflow-test` depend on two things still
landing: the `interact` tool (click/input/select, ephemeral, diffs the page per
action) their explore/test steps assume, and the two CLI commands (`builder
await-turn`, `workflows gen-payloads`) they now call, which shim server endpoints
that must ship first. Shared references (`node-naming.md`, `task-messages.md`,
`input-schema.md`, `templates/plan-branching.md`) carry worked examples. Install
maps all six packs to Claude Code (`.claude/skills/`), Cursor (`.cursor/skills/`),
and the shared `.agents/skills/` path (Codex, Devin) via `--target`.
