# Captchas

Which captchas the platform solves, when to switch to manual solving, and the
pattern for text captchas. The builder agent builds all of these; delegate by
naming the captcha and where it appears. The node shapes below are for authoring
directly or checking what the builder built. Node semantics are in the
`cloudcruise-workflow-dsl` skill.

## Automatic solving

The platform solves Cloudflare Turnstile and reCAPTCHA v2. By default the solver
runs before every action, in builder sessions and in runs. Do not author a `CLICK`
on a captcha widget: clicking into a half-solved widget breaks the solver.

## Manual solving

Keep automatic solving on unless asked, or unless one of these problems appears:

- A submit refreshes the widget on the same page, and the solver solves it again
  for no reason.
- A long page fill lets the token expire before the action that needs it.

To solve explicitly, in the same update set `manual_captcha_solve: true` and add a
`CAPTCHA` node immediately before each action that needs the captcha cleared. Set
`captcha_type` to the captcha shown on the page. With the flag on, the platform
solves captchas only at `CAPTCHA` nodes, so the flag without the nodes leaves every
captcha unsolved.

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

State the captcha type and the page or step where it appears. For manual solving,
state which problem above calls for it.

## In testing

These failures have known fixes:

- A `CAPTCHA` node fails with `CAPTCHA-E0001`: a captcha was present and not
  solved.
- A submit is rejected after a long fill on an auto-solved captcha: the token
  expired. Switch to manual solving.
- A text captcha is rejected and the run does not retry: the retry loop is
  missing. Add it.
