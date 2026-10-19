# Captchas

Which captchas the platform solves, where the `CAPTCHA` node goes, and the
pattern for text captchas. The builder agent builds all of these; delegate by
naming the captcha and where it appears. The node shapes below are for authoring
directly or checking what the builder built. Node semantics are in the
`cloudcruise-workflow-dsl` skill.

## Solving at a CAPTCHA node

The platform solves Cloudflare Turnstile, reCAPTCHA v2, hCaptcha and AWS WAF
CAPTCHA at a `CAPTCHA` node. New workflows start with `manual_captcha_solve: true`,
so captchas are solved only at these nodes.

When a page shows one of these captchas, add a `CAPTCHA` node with the matching
`captcha_type` immediately before the action that needs it cleared, usually the
submit or the next navigation. Do not author a `CLICK` on a captcha widget:
clicking into a half-solved widget breaks the solver.

Some sites open an invisible hCaptcha or an AWS WAF CAPTCHA puzzle from their own
checkbox ("I am not a robot", "Let's confirm you are human"), a site element rather
than the captcha's widget, and the challenge appears a few seconds after the click.
Click the site's checkbox with a `CLICK` node and put a `CAPTCHA` node with
`captcha_type: "hcaptcha"` or `"aws_waf"` right after it. That node waits up to 15
seconds for the challenge to open, then solves it. AWS WAF CAPTCHA can also show as
AWS's full-page "Human Verification" page; don't click its Begin button, because the
`CAPTCHA` node presses it.

## Automatic solving

With `manual_captcha_solve: false` the solver runs before each step that acts on the
page, in builder sessions and in runs. Existing workflows keep their setting; most
created before manual solving became the default have `false`. `CAPTCHA` nodes work
in those workflows too. To move one to manual solving, in the same update set
`manual_captcha_solve: true` and add the `CAPTCHA` nodes: the flag without the nodes
leaves every captcha unsolved.

## Text captchas

A distorted-character image plus a text input. The platform does not auto-solve
these. The transcription can be wrong, and a rejected attempt renders a fresh
challenge, so author a retry loop, not a straight line:

```
[fill form fields]
  → EXTRACT_DATAMODEL ("Read captcha image", LLM_VISION)
  → INPUT_TEXT ("Enter captcha code", human_mode)
  → CLICK ("Submit")
  → BOOL_CONDITION ("Captcha still present?", max_iterations)
      ├─ true → back to EXTRACT_DATAMODEL (rejected — re-read the new challenge)
      └─ false → [next node]
```

The `EXTRACT_DATAMODEL` uses `execution: "LLM_VISION"` and a single string field
whose `description` tells the model to transcribe the challenge image:

```json
{
  "id": "<crypto.randomUUID()>",
  "name": "Read captcha image",
  "action": "EXTRACT_DATAMODEL",
  "parameters": {
    "execution": "LLM_VISION",
    "model": "gemini | gemini-2.5-flash",
    "extract_data_model": {
      "type": "object",
      "properties": {
        "captcha_text": {
          "type": "string",
          "selected": true,
          "description": "The characters shown in the captcha challenge image, exactly as displayed"
        }
      },
      "required": ["captcha_text"]
    }
  }
}
```

## In a task message

State the captcha type and the page or step where it appears, and the action
that needs it cleared.

## In testing

These failures have known fixes:

- A `CAPTCHA` node fails with `CAPTCHA-E0001`: a captcha was present and not
  solved.
- A submit is rejected after a long fill on an auto-solved captcha: the token
  expired. Switch the workflow to manual solving.
- A text captcha is rejected and the run does not retry: the retry loop is
  missing. Add it.
- A captcha stays unsolved on a workflow with `manual_captcha_solve: true`: the
  `CAPTCHA` node before the action that needs it is missing. Add it.
- An hCaptcha or AWS WAF challenge opens after a click on the site's own checkbox
  and stays unsolved: the `CAPTCHA` node after that click is missing. Add it.
