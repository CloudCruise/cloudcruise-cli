# Captchas

The platform solves **Cloudflare Turnstile** and **reCAPTCHA v2** on its own, during
building and at run time. By default the solver runs before every action. A captcha
inside an iframe is not detected and counts as absent. If one stays unsolved and
blocks the page, the builder reports it and stops.

**Text-transcription captchas** (distorted image plus a text box) are not
auto-solved. The builder knows the pattern and authors a retry loop, because a wrong
read renders a fresh image:

```
[fill form fields]
  → EXTRACT_DATAMODEL  read the challenge image (LLM_VISION, one string field)
  → INPUT_TEXT         type the code (human_mode)
  → CLICK              submit
  → BOOL_CONDITION     captcha still present? (max_iterations set)
      ├─ true  → back to EXTRACT_DATAMODEL
      └─ false → next node
```

Your task message only names where the captcha sits between steps. Anything else
(hCaptcha, reCAPTCHA v3, image-pick puzzles that are not reCAPTCHA v2): stop and
tell the user.

## Automatic vs manual

The workflow field `manual_captcha_solve` (boolean, default `false`) controls the
solver. `false`: it runs before every action. `true`: the platform makes no
automatic attempt; solving happens only where the graph places a `CAPTCHA` node.

The builder sets it through its workflow write tool when you ask. On a saved
workflow you can also set it from the CLI: `workflows update <id> --file` with
`"manual_captcha_solve": true` in the file.

## The `CAPTCHA` node

Solves one named captcha at that point in the graph. It runs whether the flag is on
or off.

```json
{ "action": "CAPTCHA", "name": "Solve Turnstile before submit",
  "parameters": { "captcha_type": "turnstile" } }
```

`captcha_type` is required: `turnstile` or `recaptcha_v2`. No captcha of that kind
on the page: the node passes. Present and solved: passes. Present and unsolved:
fails with `CAPTCHA-E0001`, so the workflow's error-code actions (retry, alert,
pause) apply.

## When to switch to manual

Two symptoms in a build or test turn justify it:

- Several actions on the captcha page let the token expire, and each action
  triggers a fresh solve.
- A submit refreshes the widget on the same page and the solver clears it again for
  nothing.

Send one message, as a goal:

> The captcha on <page> is re-solved on every action. Set `manual_captcha_solve` to
> true and place a CAPTCHA node, with the kind you see on the page, immediately
> before each action that needs it cleared.

Then re-prove the component from its first node.
