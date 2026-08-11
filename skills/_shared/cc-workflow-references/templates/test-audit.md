# Test audit — <workflow name>

One line per run. Newest last.

| # | payload | session_id | verdict | disposition |
|---|---------|-----------|---------|-------------|
| 1 | payloads/happy-path.json | | | |

Verdict: `green` (completed) · `run-failed` · `blocked` (needs a human decision).
Disposition: which of the three options applied — `logged` (noted, moved on) ·
`fixed: <what>` (mechanical fix, rewound, resumed) · `blocked: <what's needed>`.

Rules discovered while testing (value constraints, null semantics, timing) are
codified back into the input_schema — a rule that lives only in this file is a miss.
