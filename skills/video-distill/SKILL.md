---
name: video-distill
description: Download a Loom (or local) screen recording, transcribe the narration, extract frames, and correlate them into a structured step-by-step walkthrough — numbered UI actions with exact label text, every input value typed, what the final result screen shows, and narrator gotchas verbatim. Use when the user points at a Loom link or a local video and wants its on-screen workflow distilled into actionable steps.
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob
---

# Loom Distiller — Video Walkthrough → Structured Steps

Turn a screen-recording of someone performing a workflow into a precise, structured
walkthrough. Given a Loom link or a local video file, this skill downloads the video,
transcribes the narration, samples frames, and correlates audio with visuals into a
step-by-step account of exactly what was done on screen.

## Arguments

The skill argument is a **video source** — either a Loom URL
(`https://www.loom.com/share/...`) or an absolute path to a local video file — optionally
followed by context notes (e.g. what the workflow is, known input variables/values). If no
source was given, ask for it before doing anything else. That is the only permitted
question.

## Do the heavy lifting in a SUBAGENT

Downloading, transcribing, and reading frames dumps a lot into context. Spawn a subagent
to do the mechanical work and return only the distilled result — protect the main context.
If several videos are requested, spawn them in parallel (one subagent per video).

## Procedure (per video)

Work in the scratchpad directory. Bootstrap tooling once (reuse the venv across videos in
the same run):

```bash
python3 -m venv venv && venv/bin/pip install yt-dlp mlx-whisper   # ffmpeg is on PATH
```

1. **Get the video.**
   - Local path given → use it directly.
   - Loom URL → `venv/bin/yt-dlp -o video.mp4 "<loom-url>"`.
   - If yt-dlp fails (download-restricted looms), scrape the loom share page for the CDN
     mp4 URL and fetch that.
   - Unobtainable → stop and report the failure (don't fabricate a walkthrough).

2. **Extract + transcribe audio.**
   ```bash
   ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 audio.wav
   venv/bin/mlx_whisper audio.wav
   ```

3. **Sample frames and correlate.**
   ```bash
   ffmpeg -i video.mp4 -vf fps=1/2 frame_%04d.png   # one frame every 2s
   ```
   Read the frames in order and align them with the transcript timeline — the narration
   says *why*, the frames show *what was clicked/typed*. Adjust the fps if the video is
   very long (fewer frames) or very dense/fast (more frames).

## Output — the distilled walkthrough

Return (and, if the user asked for a file, write) the following:

- **Summary** — 2–6 sentences: what the flow accomplishes, entry point, the navigation
  path, what gets searched/filtered, and what result/status the workflow ends on.
- **Steps** — a numbered action list distilled from video + transcript, each step naming
  the **exact on-screen UI label text** clicked or interacted with (buttons, menu items,
  field labels, tabs).
- **Inputs** — every value typed into the demo (search terms, IDs, form field values),
  paired with the field it went into.
- **Final screen** — precisely what the ending result/status screen shows (the fields and
  values the workflow is meant to surface).
- **Narrator notes / gotchas** — any instructions, caveats, or "watch out for…" the
  narrator called out, quoted verbatim.
- **Concerns** — ambiguities, any step whose effect is unclear, or anything that looks
  like it changes state rather than just reading it.

## Notes

- Prefer transcript + frames together; neither alone is reliable — the narration omits
  exact labels, and silent frames omit intent.
- Report honestly: if a step is ambiguous or a label is unreadable in the frames, say so
  in **Concerns** rather than guessing a plausible label.
