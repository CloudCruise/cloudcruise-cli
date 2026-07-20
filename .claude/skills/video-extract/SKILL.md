---
name: video-extract
description: Turn a Loom (or local) workflow recording into a DENSE structured plan for building a CloudCruise workflow — per-section steps with every conditional branch enumerated, a visual anchor for on-screen recognition, narrated constraints as candidate ADRs, and the demonstrated reset recipe (entry path to a clean form). First stage of the builder-drive pipeline; feeds plan-compile. Forked child; never invoked directly by a user.
context: fork
agent: general-purpose
user-invocable: false
allowed-tools: Bash, Read, Write, Grep, Glob
---

# video-extract — recording → dense structured plan

You are a **fork** and the first stage of the builder-drive pipeline. You turn a screen recording
of someone performing a workflow into a **dense, structured plan** that everything downstream
grades against, then **return a short summary** (the plan itself is written to disk). Nothing
downstream can verify against intent it never received, so **enumerate everything** — especially
every conditional branch.

## Arguments contract

`$ARGUMENTS`: a **video source** (a Loom URL or an absolute path to a local video), optional context
notes (what the workflow is, known inputs/values, the target start URL), and an `outPath` for the
plan file (default `plan.md` in the working dir). If no source is given, that is the only thing you
may stop to ask for.

## Extraction engine — reuse video-distill

The download / transcribe / frame-sample mechanics are the proven `video-distill` procedure — do
not reinvent them. Bootstrap once and run it in *this* fork (you already are the subagent that
protects the main context):

```bash
python3 -m venv venv && venv/bin/pip install yt-dlp mlx-whisper     # ffmpeg is on PATH
venv/bin/yt-dlp -o video.mp4 "<loom-url>"                            # or use the local path
ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 audio.wav && venv/bin/mlx_whisper audio.wav
ffmpeg -i video.mp4 -vf fps=1/2 frame_%04d.png                      # 1 frame / 2s; raise if dense
```

Read frames in order against the transcript timeline — narration says *why*, frames show *what was
clicked/typed*. If the download fails or the video is unobtainable, **stop and report** — never
fabricate a plan. (See `/video-distill` for the download-fallback details.)

> The kickoff referenced a "Gemini-based extraction prompt." The only Gemini video prompt in the
> codebase is the maintenance agent's *run-error* analyzer (Langfuse-hosted), not a Loom-walkthrough
> extractor — so this skill uses the on-disk `video-distill` engine instead. If a dedicated Gemini
> extraction prompt is preferred, swap the engine above for it; the enrichment + output contract
> below is unchanged.

## What to extract — the plan (beyond a plain walkthrough)

`video-distill` gives you the base walkthrough (summary, numbered steps with exact UI label text,
every typed input, final screen, narrator gotchas). **Enrich it** into the plan with four additions
the downstream skills depend on:

1. **Every conditional branch enumerated.** Wherever the flow forks (a value present/absent, a
   status, a role, an "if X then Y" the narrator mentions or the screen implies), name both arms and
   what each does — even arms the demo didn't take. run-investigate checks branch reachability
   against this list; an un-enumerated branch is invisible to it forever.
2. **A visual anchor per section** — how to recognize this section on screen: page title,
   distinctive header text, unique layout. run-investigate uses these as frame-registration points
   to align the run video to the node list, so make them concrete and unambiguous.
3. **Narrated constraints → candidate ADRs.** Every "you must…", "always…", "never…", "watch out
   for…", business rule, or value constraint the narrator states → a candidate ADR (one line: the
   constraint + where it applies). ADRs come from **narration + video only** — no standing library.
4. **The reset recipe.** The recording starts from fresh state, so the entry path to a clean form is
   demonstrated in the **opening** — extract it explicitly (the exact navigation/clicks to get back
   to a clean starting form). This is the recovery manual `work` and `builder-drive` use to recover
   a stuck section; get it precise.

## Output contract (write to `outPath`)

Crude-but-structured markdown — this is the contract plan-compile parses and run-investigate grades
against. One block per section, plus top-level reset recipe + constraints:

```markdown
# Plan: <workflow name>
start_url: <url if known>

## Reset recipe
<exact steps demonstrated in the opening to reach a clean starting form>

## Constraints (candidate ADRs)
- C1: <constraint> — applies to <section/step>
- C2: ...

## Section 1 — <name>
visual_anchor: <page title / header / layout that identifies this section on screen>
steps:
  1. <action on exact UI label> [input: <value + field>]
  2. ...
branches:
  - if <condition>: <arm A — what happens> | else: <arm B>
constraints: [C1]        # ADR refs that bind this section
notes: <gotchas verbatim, ambiguities>

## Section 2 — ...
```

Then **return a short summary**: the workflow name, section count, branch count, ADR-candidate
count, whether the reset recipe was found, and the `outPath`. Flag in the summary any section whose
effect is ambiguous or any label unreadable in the frames — honesty over a plausible guess. Do not
return the full plan; it's on disk.
