#!/usr/bin/env bash
# GREEN mode — sample the WHOLE session video at a modest uniform rate for plan-to-video
# completeness grading. There are no per-node timestamps in the video, so alignment is by
# node-execution ORDER: read the frames in sequence and register them against the plan's
# node list using the per-section VISUAL ANCHORS (page title / distinctive header / layout).
#
# When per-node timestamps ship (or via the always-debug snapshot spine — see SKILL.md),
# swap this uniform sweep for timestamp-indexed extraction.
#
# Usage:
#   green_frames.sh <signed_video_url> <outdir> [fps]
#   fps default 0.5 (one frame / 2s). Raise for short/dense runs, lower for long ones.
set -euo pipefail
URL="${1:?signed_screen_recording_url (the LAST/longest segment for a clean full run)}"
OUT="${2:?outdir}"; FPS="${3:-0.5}"
mkdir -p "$OUT"; VID="$OUT/session.mp4"

echo "downloading video..."; curl -s "$URL" -o "$VID"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID" 2>/dev/null)
echo "duration=${DUR}s  sampling @${FPS}fps"
ffmpeg -hide_banner -loglevel error -i "$VID" -vf "fps=${FPS}" -q:v 4 "$OUT/g_%04d.jpg"

N=$(ls "$OUT"/g_*.jpg 2>/dev/null | wc -l)
echo "frames in $OUT: $N"
echo "READ ORDER: g_0001 → g_${N} in sequence; register each against the next expected plan"
echo "section via its visual anchor. A section with NO matching frames = never executed."
