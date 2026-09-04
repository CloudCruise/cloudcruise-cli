# OpenAI plugin directory — initial submission (v1.11.5)

Cut from [`docs/openai-plugin-submission.md`](../openai-plugin-submission.md)
on 2026-09-01. Listing fields, starter prompts, and test cases are copy-pasted
from that doc at this version; it stays the source of truth for future
submissions.

- **Date**: 2026-09-01
- **Submission type**: initial
- **Plugin version**: 1.11.5
- **Archive**: [`cloudcruise-openai-plugin-v1.11.5.zip`](./cloudcruise-openai-plugin-v1.11.5.zip)
  (built with `npm run build:openai-plugin`; 6 skills, manifest at
  `.claude-plugin/plugin.json`, no marketplace.json, symlinks dereferenced)
- **Logo**: [`assets/logo-512.png`](../../assets/logo-512.png) (512×512 PNG,
  exported from `assets/logo.svg`)

## Release notes

- Purpose: CloudCruise workflow lifecycle skills (build / test / debug + CLI
  and DSL reference).
- Submission type: initial.
- Changes: first submission — ships the six skills as of CLI v1.11.5:
  `cc-workflow` (entry/routing), `cc-workflow-setup` (plan authoring),
  `cc-workflow-build` (builder-agent build loop), `cc-workflow-test`
  (dry-run testing with a payload confirmation gate), `cloudcruise`
  (CLI reference), and `cloudcruise-workflow-dsl` (workflow DSL reference).

## Status

- [ ] Submitted at platform.openai.com
- [ ] Review outcome: <!-- accepted / changes requested (link feedback) -->
