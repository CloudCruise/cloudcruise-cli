# Input: screen recording → skeleton

video → frames → output. This doc owns getting from video to frames and from
frames to a skeleton draft; `input-screenshots.md` reuses the frames-to-output half
directly; `input-text.md` needs neither.

## Extraction mode

Declared once, up front, in `cc-workflow-setup` step 4, for whatever modality mix
is in play: **strict steps** (a fixed linear sequence — read for what happened, in
order) or **the shape of the path to the goal** (real branching — read for what's
conditional on what). This aims the read; it doesn't fix `complexity`, which is
still set from what the draft actually turns out to be — observed, not asked, even
though the mode was.

## Video → frames

```bash
ffmpeg -i video.mp4 -vf fps=1 frame_%04d.png
ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 audio.wav && venv/bin/mlx_whisper audio.wav
```

Always 1fps — no duration-based tuning. Narration supplies intent and rules;
frames supply what's actually on screen. Distrust the transcript for jargon and
proper nouns (whisper garbles domain terms) — labels come from pixels, not audio.

## Frames → output

Read frames in order. A short recording: read it directly, no subagent —
spawning one for a two-minute clip wastes more than it saves.

A long recording, where subagents are available: split the frame sequence into
batches, one subagent per batch, run in parallel, with a handful of frames' overlap
between adjacent batches so an action spanning a batch boundary doesn't get missed
by both sides or double-counted by both. Each batch subagent reads its frames (and
the transcript slice covering the same window) and returns a partial extraction in
the declared mode — a segment of steps, or a segment of the page/component shape.

**Where they aren't** — some harnesses withhold subagents entirely — read the
frames directly, several per message rather than one at a time; parallel reads in a
single turn are always available and are most of the speed. The two mechanisms
solve different problems and neither is a substitute for the other: batching buys
latency, subagents buy context (the pixels stay in the subagent and only the
extraction comes back). Never make a step depend on subagents alone.

Reading every frame is not the goal at either scale. Let the transcript pick them:
narration marks the transitions, so read around the timestamps where the speaker
changes page or section, plus enough between to catch what they scrolled past in
silence. A sixteen-minute walkthrough yields its structure in a few dozen frames,
not a thousand.

If a moment's genuinely unclear, note it and move on — the confirm loop at setup
step 4 is where an unclear draft gets corrected, not a video-analysis pass trying to
resolve everything up front.

## Merge

The calling setup flow stitches the batch outputs (or the single direct read) into
one skeleton draft, using the overlap to reconcile boundaries — the same action
seen at the tail of one batch and the head of the next is one step, not two. This
draft is what enters the existing present → accept/amend/reject loop; nothing
downstream needs to know it came from multiple partial reads.
