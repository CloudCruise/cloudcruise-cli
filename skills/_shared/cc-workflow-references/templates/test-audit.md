# Test ledger — <workflow name>

Per payload run and per error inside it. The errors and their fixes are the only record.

## Payload runs

| payload (label) | source | intent | reset used | reached end? |
|-----------------|--------|--------|------------|--------------|
| | | | | |

Payload files live in `payloads/<label>.json`. Source: `example` · `user` · `agent`.
Reset: `fresh-task` · `restored` · `dirty (findings discounted)`.

## Errors + fixes

| payload | where (node / page) | what failed | root cause | fix | verification |
|---------|---------------------|-------------|-----------|-----|--------------|
| | | | | | |

- **fix**: `none` (localized, logged) · `<what was changed>` (confident mechanical fix) ·
  `blocked: <what a human must decide>`.
- **verification** (for an applied fix): `verified-full` (re-ran from start) ·
  `verified-partial` (restored to a runnable point + ran) · `unverified` (could neither
  re-run nor restore) · `n/a` (no fix / blocked).

Rules discovered while testing (value constraints, null semantics, timing) are codified back
into the input_schema — a rule that lives only in this file is a miss.
