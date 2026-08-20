# Input: screen recording → skeleton

acquire → video → frames → output. This doc owns getting from a recording (or a
Loom URL) to frames and from frames to a skeleton draft; `input-screenshots.md`
reuses the frames-to-output half directly; `input-text.md` needs neither.

## Prerequisites

Check up front:

- `ffmpeg` — frames and audio extraction.
- `curl` — the Loom acquire path.
- an ASR tool (`mlx_whisper`, `whisper`, `whisper.cpp` — any installed) —
  narrated video without captions.

Missing ASR tool: extract from frames alone (silent path below) and tell the
user which tool would unlock the narration.

## Extraction mode

Inferred once, up front, in `cc-workflow-setup` step 4, for whatever modality mix
is in play: **strict steps** (a fixed linear sequence — read for what happened, in
order) or **the shape of the path to the goal** (real branching — read for what's
conditional on what). This aims the read; it doesn't fix `complexity`, which is
still set from what the draft actually turns out to be. Both are observed, not
asked.

## Acquire: Loom URL → video + transcript

A Loom share link (`loom.com/share/<id>`) yields metadata, the mp4, and the
official captions in three `curl` calls. A video file handed over directly skips
this section and enters at Video → frames.

```bash
ID=<id>   # from the share URL
UA="Mozilla/5.0"

# 1. Metadata — GET the share page: title, duration, "transcription_status"
curl -s -A "$UA" "https://www.loom.com/share/$ID" > page.html

# 2. Video — POST mints a signed CDN URL; download immediately (~1h expiry)
curl -s -X POST -A "$UA" -H "Content-Type: application/json" -d '{}' \
  "https://www.loom.com/api/campaigns/sessions/$ID/transcoded-url"
# → {"url": "https://cdn.loom.com/sessions/transcoded/<id>.mp4?Policy=..."}

# 3. Transcript — POST GraphQL for the signed captions VTT; download immediately
curl -s -X POST -A "$UA" -H "Content-Type: application/json" \
  -d '{"operationName":"FetchVideoTranscript","variables":{"videoId":"'$ID'","password":null},"query":"query FetchVideoTranscript($videoId: ID!, $password: String) { fetchVideoTranscript(videoId: $videoId, password: $password) { ... on VideoTranscriptDetails { captions_source_url source_url __typename } ... on GenericError { message __typename } __typename } }"}' \
  "https://www.loom.com/graphql"
# → captions_source_url: signed cdn.loom.com .vtt
```

Password-protected or workspace-restricted Looms: pass the password in the
GraphQL `variables`, or ask the user to download the mp4 and hand it over.
`transcription_status` ≠ `success` means no captions — use ASR below.

## Video → frames

```bash
ffmpeg -i video.mp4 -vf fps=1 frame_%04d.png
```

Always 1fps. Any timestamped transcript — Loom VTT or ASR output — aligns by
arithmetic: a cue starting at second `s` is frame `floor(s)+1`.

When a narrated video has no captions, transcribe with the installed ASR tool:

```bash
ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 audio.wav
mlx_whisper audio.wav   # or whisper, whisper.cpp
```

No transcript (silent video, or no ASR tool): extract from frames alone — silent
path below — and note in the draft that intent came unstated.

Narration supplies intent and rules; frames supply what's actually on screen.
Distrust the transcript for jargon and proper nouns (ASR garbles domain terms) —
labels come from pixels, not audio.

## Frames → output

Read frames in order. A short recording: read it directly, no subagent —
spawning one for a two-minute clip wastes more than it saves.

A long recording, where subagents are available: split the frame sequence into
batches, one subagent per batch, run in parallel, with a handful of frames' overlap
between adjacent batches so an action spanning a batch boundary doesn't get missed
by both sides or double-counted by both. Each batch subagent reads its frames (and
the transcript slice covering the same window, when one exists) and returns a
partial extraction in the declared mode — a segment of steps, or a segment of the
page/component shape.

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

Without a transcript, let the pixels pick instead: read a coarse stride first
(every ~10th frame of the 1fps sequence), find where the screen changes page or
section, and zoom into those spans at full 1fps. ffmpeg can pre-mark transitions
the stride misses:

```bash
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',showinfo" -vsync vfr scene_%04d.png
```

A silent video yields actions but not intent — why a field got that value, what
rule governed a branch. Extract the actions; the missing whys surface as
amendments in the confirm loop.

If a moment's genuinely unclear, note it and move on — the confirm loop at setup
step 4 is where an unclear draft gets corrected, not a video-analysis pass trying to
resolve everything up front.

## Merge

The calling setup flow stitches the batch outputs (or the single direct read) into
one skeleton draft, using the overlap to reconcile boundaries — the same action
seen at the tail of one batch and the head of the next is one step, not two. This
draft is what enters the existing present → accept/amend/reject loop; nothing
downstream needs to know it came from multiple partial reads.
