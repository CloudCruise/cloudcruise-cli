# Captchas

What the platform and the builder agent handle, so you know what to delegate. The
builder builds every captcha mechanism; you name the captcha and where it appears.

## By captcha type

- **Cloudflare Turnstile, reCAPTCHA v2 — auto-solved.** The platform runs its
  solver before every action, in builder sessions and in runs. Nothing to plan or
  delegate.
- **Manual solve — for the same two types, on request.** The builder turns on the
  workflow's `manual_captcha_solve` flag and places a `CAPTCHA` node before each
  action that needs the captcha cleared. Ask for it only when auto-solve causes one
  of these problems:
  - A submit refreshes the widget on the same page, and the solver solves it again
    for no reason.
  - A long page fill lets the token expire before the action that needs it.
- **Text captchas — the builder's pattern.** A distorted-character image plus a
  text input. The platform does not auto-solve these; the builder has a pattern
  for them. Tell the builder the captcha is there and let it build the pattern.

## In a task message

State the captcha type and the page or step where it appears. For manual solve,
state which problem above calls for it. Leave the nodes to the builder.

## In testing

Hand these to the builder as fixes:

- A `CAPTCHA` node fails with `CAPTCHA-E0001` (see the `cloudcruise-workflow-dsl`
  skill): a captcha was present and not solved.
- A submit is rejected after a long fill on an auto-solved captcha: the token
  expired — ask for manual solve.
- A text captcha is rejected and the run does not retry: the pattern is missing —
  ask the builder to build it.
