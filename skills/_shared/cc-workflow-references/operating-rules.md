# Operating rules — all stages

Safety and driving discipline. Every skill in the family loads this. Each rule below
was earned by a real failure; keep the rationale with the rule.

## Safety

- **Productionized workflows are read-only.** A workflow driving real transactions in
  a real external system is never executed as a diagnostic step without explicit
  authorization. "On the prod environment" ≠ "safe to run"; when unsure, ask.
- **≤2 authentication attempts, then escalate.** Lockout risk. Escalate without
  blocking: state the blocker, what was tried, the decision needed — and keep working
  any unblocked path.
- Never persist secrets to plaintext; credentials flow through the vault only.

## Driving discipline

- **Execute once.** A failed fill has already mutated the page; a retry fails on
  side-effect state, not node correctness, and lies about the fix. Log fail, continue.
- **Never insert an unvalidated selector.** Any XPath entering a node is confirmed
  unique against the live DOM first — doubly so for selectors gating control flow,
  which fail silently.
- **Prefer a plain wait over a clever guard.** Settle delays get you through the form;
  conditional retry loops with unverified predicates are infinite loops waiting to
  happen.
- **Never reload to clear UI state.** Modals are dismissed with Cancel; lost state is
  recovered by seeding the section's entry node — never a full run from START.
- **Diagnose before hardening.** Pull the DOM and count matches before encoding any
  theory into nodes; the first plausible theory is often wrong.
- **Inventory is never stored; relations always are.** Field lists and enum values
  come fresh from census; reveal relations, rituals, and rules get written down.

## CLI consumption

- Machine JSON on stdout, diagnostics on stderr. Consume stdout only; never `2>&1`
  when parsing. Branch poll loops on exit codes, not JSON string matching.

## Status

STUB — rules settled; expand each with its one-line incident rationale.
