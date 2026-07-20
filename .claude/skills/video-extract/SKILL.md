---
name: video-extract
description: Turn a Loom (or local) workflow recording into a DENSE, frame-accurate plan for building a CloudCruise workflow — timestamped actions, a full input inventory (every field, verbatim labels + option lists), gating dependencies, observed-vs-speculative branches, per-section visual anchors, narrated constraints as candidate ADRs, the reset recipe, and a marked gaps list. First stage of the builder-drive pipeline; feeds plan-compile. Forked child; never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# video-extract — recording → dense structured plan

You are a **fork** and the first pipeline stage. You do **dense, frame-accurate observation — not a
summary** — and write a structured plan to disk, then return a short summary. An automation agent
rebuilds the task from your plan and knows **only what you wrote down**: assume every on-screen
detail you drop is lost forever. Length is not a concern; a long, gap-marked plan is the goal.

## Arguments contract

`$ARGUMENTS`: a **video source** (Loom URL or absolute local path), optional context notes (what the
workflow is, known inputs/values, the target start URL), and an `outPath` (default `plan.md`). If no
source is given, that is the only thing you may stop to ask for.

## Engine + the Claude Code advantage

Get frames + transcript with the proven `video-distill` mechanics (run them here — you are the fork
that protects the main context):

```bash
python3 -m venv venv && venv/bin/pip install yt-dlp mlx-whisper     # ffmpeg on PATH
venv/bin/yt-dlp -o video.mp4 "<loom-url>"                           # or the local path
ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 audio.wav && venv/bin/mlx_whisper audio.wav
ffmpeg -i video.mp4 -vf fps=1 frame_%04d.png                       # 1 fps baseline; raise if dense
```

**Unlike a one-shot video model, you can look again.** Before you ever mark something a gap,
**re-sample that moment denser and re-read** — a blurred dropdown, a fast scroll, an unreadable
label are usually recoverable:

```bash
ffmpeg -ss 71 -to 78 -i video.mp4 -vf fps=6 zoom_%03d.png          # tight window, high fps
```

Use this liberally on any dropdown open, fast scroll, or ambiguous click. A gap you *could* have
resolved by re-watching is a failure, not a limitation.

## How to observe (the discipline)

- **Sequentially, in small batches** (~30–60s of frames). Fully report a batch before the next —
  never watch the whole thing then write from an overall impression; that is how detail is lost.
- **Every new page / modal / panel / tab → inventory it fully** (all fields, per below) *before*
  following what the cursor does next.
- **Scrolling reveals content.** Fields scrolled past quickly still exist and still get inventoried —
  transcribe what's legible, re-sample the rest.
- **Register every discrete state change** — clicks, typed text, dropdown opens, selections, scrolls
  to a new region, focus changes, tooltips, modals, toasts, spinners, page loads.

**Two failure modes, both unacceptable:**

- **Confabulation** — writing what the pixels don't support. When unsure what happened, what an
  element is, or why, **say so** (`[?] unclear — couldn't see the click target @1:12`) rather than
  guess.
- **Compression** — summarizing detail away. Never "fills several fields", "various options",
  "etc.", "similar to before", "repeats the process". If something repeats, say exactly what is
  identical and **enumerate what differs**. Replace any "etc." with the actual items or
  `[remaining items not legible]`.

A **marked** gap is fine; a **silent** gap or an invented detail is not.

**Verbatim, always, for labels and option lists.** Transcribe only what is in the pixels. **Never
fill enum options from your knowledge of standard forms** — this form may be a customized variant,
and a plausible-but-wrong enum is worse than a marked gap. Use `[options not visible]` /
`[list truncated after "X"]` when a list wasn't opened or isn't legible (after re-sampling).

## Output contract — the plan (`outPath`)

Crude-but-structured markdown; this is what `plan-compile` parses and `run-investigate` grades
against. Top matter + one block per section:

```markdown
# Plan: <workflow name>
start_url: <url if legible>

## Reset recipe
<exact steps from the OPENING to reach a clean starting form — the recovery manual>

## Constraints (candidate ADRs)
- C1: <narrated must/never/always/business rule/value constraint> — applies to <section/step>

## Parameterization
- varies per run: <names, ids, dates, search strings, clinical answers…>
- constant / structural: <…>

## Section 1 — <name>
visual_anchor: <page title / distinctive header / layout that identifies this on screen>
skeleton:                         # every discrete action, timestamped
  0:03  click "Search" (top-right)
  0:05  type "12345" into "Order #"
  0:08  URL → app.example.com/orders   # note URL at each page load / tab switch / redirect
input_inventory:                  # EVERY field on this page — interacted or not, skipped counts
  - "C0100 Reason for assessment" | 0:11 | single-select | options: ["01 - Admission","02 - ..."] | default: none | set to: "01 - Admission"
  - "Notes" | 0:14 | free text | set: no
branches:
  observed:    - if <cond> hit in the recording → <arm>
  speculative: - <plausible untested branch — validation fail / empty result / timeout> [untested]
dependencies:                     # gating, both directions
  - "Other" = checked → "Other detail" (revealed)                # activation: parent→child
  - "Diagnosis" = set → "Onset date" (required) [inferred from fill order]   # requirement: child→parent
constraints: [C1]                 # ADR refs binding this section
notes: <gotchas verbatim, ambiguities>

## Section 2 — ...

## Gaps & uncertainties
- 1:12 [?] couldn't see click target after "Submit" — agent should probe live
- 2:40 [options not visible] "Facility" dropdown never opened
```

Rules baked into the format: **every branch enumerated** (both arms, even untaken); **one line per
input** (never collapse "the PHQ-9 questions" into one line — list each); enum option lists
**verbatim with codes/prefixes** (they become the workflow's enum values, so casing matters);
dependencies as one line each with direction; gaps consolidated with timestamps (err toward listing
too much — this section is the agent's live-probe list).

## Return

A short summary only (the plan is on disk): workflow name, counts (sections / total inputs /
branches observed+speculative / candidate ADRs / gaps), whether a reset recipe was found, and the
`outPath`. Flag the biggest ambiguities. Do not return the plan body.
