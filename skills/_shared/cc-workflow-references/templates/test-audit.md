# Test audit — <workflow name>

One line per run. Newest last.

| # | payload | session_id | verdict | disposition |
|---|---------|-----------|---------|-------------|
| 1 | payloads/happy-path.json | | | |

Verdict: `green` (run succeeded + expectation held) · `run-failed` · `mismatch`.
Disposition: what was done about it — `fixed: <what>` · `payload-error` ·
`known-issue: <ref>` · `open`.

Rules discovered while testing (value constraints, null semantics, timing) are
codified back into the input_schema — a rule that lives only in this file is a miss.
