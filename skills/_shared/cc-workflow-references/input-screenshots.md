# Input: screenshots → skeleton

Frames without the video around them — the same frames-to-output analysis as
`input-recording.md`, minus its video-to-frames step (no download, no fps
sampling — the images ARE the frames) and minus the transcript (no audio).

## Extraction mode

Same as `input-recording.md`: the user (or setup, if unambiguous) declares strict
steps or shape-of-the-path-to-the-goal once, up front, for whatever modality mix is
in play — see `cc-workflow-setup` step 4.

## Reading the frames

Order the screenshots (by filename, by what's visibly upstream/downstream of what,
or just ask) and read them in that order. A screenshot shows a state, not an
action — treat consecutive screenshots the way `input-recording.md` treats
consecutive video frames: the later one is the *result* of whatever happened in
between, not something to independently re-derive.

## Batching

A handful of screenshots: read them directly, no subagent. A large set: split into
overlapping batches, one subagent per batch, same as `input-recording.md`'s frame
batching — the overlap exists so a state that spans a batch boundary doesn't get
missed or split across two partial reads.

## Merge

Whatever came back — one direct read or several batch subagents' partial reads —
gets stitched into one skeleton draft by the calling setup flow, per the declared
extraction mode. Same merge step as `input-recording.md`.
