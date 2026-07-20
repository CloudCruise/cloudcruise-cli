#!/usr/bin/env bash
# Extract the error region of a run's session video as frames the agent can Read.
#
# VIDEO IS GROUND TRUTH. The labeled error screenshot is usually captured a few
# hundred ms AFTER the failure, once the DOM is already in a derived/bad state — so
# it shows the SYMPTOM, not the cause. The cause is almost always UPSTREAM, in the
# seconds before the error. Read the frames working backwards from t_err.
#
# ANCHOR = the error screenshot timestamp (reliable), NOT freeze detection.
#   video_start = video_ts - duration      (video_ts is the recording's finalize/end time)
#   t_err       = error_ts - video_start  = duration - (video_ts - error_ts)
# We compute t_err from the two timestamps + the real ffprobe duration, then sample
# ONE MINUTE BACK from t_err, denser as we approach it.
#
# Usage:
#   error_video.sh <signed_video_url> <outdir> <video_ts_iso> <last_error_ts_iso>
# e.g. error_video.sh "https://…" ./sweep/vid_<sid> \
#        2026-07-14T18:52:07.203896+00:00  2026-07-14T18:51:22.134Z
set -euo pipefail
URL="${1:?signed_screen_recording_url}"; OUT="${2:?outdir}"
VTS="${3:?video_urls[0].timestamp}"; ETS="${4:?last error screenshot .timestamp}"
mkdir -p "$OUT"; VID="$OUT/session.mp4"

echo "downloading video..."; curl -s "$URL" -o "$VID"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID" 2>/dev/null); DUR=${DUR%.*}
# gap (seconds) between the error frame and the video's end timestamp; t_err = dur - gap
read TERR GAP < <(python3 - "$VTS" "$ETS" "$DUR" <<'PY'
import sys
from datetime import datetime
def iso(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
vts,ets,dur=sys.argv[1],sys.argv[2],float(sys.argv[3])
gap=(iso(vts)-iso(ets)).total_seconds()
terr=max(0,min(dur, dur-gap))
print(int(round(terr)), int(round(gap)))
PY
)
echo "duration=${DUR}s  gap(video_end - error)=${GAP}s  ->  t_err=${TERR}s"

# One minute back, denser toward the error. (Drop everything after t_err+3s = the dead hang.)
CTX_A=$(( TERR>60 ? TERR-60 : 0 )); CTX_B=$(( TERR>12 ? TERR-12 : 0 ))
EZ_A=$(( TERR>12 ? TERR-12 : 0 ));  EZ_B=$(( TERR+3 ))

echo "context   [${CTX_A}..${CTX_B}] @0.3fps"
[ "$CTX_B" -gt "$CTX_A" ] && ffmpeg -hide_banner -loglevel error -ss "$CTX_A" -to "$CTX_B" \
  -i "$VID" -vf "fps=0.3" -q:v 4 "$OUT/ctx_%03d.jpg"
echo "error-zone [${EZ_A}..${EZ_B}] @3fps (tight)"
ffmpeg -hide_banner -loglevel error -ss "$EZ_A" -to "$EZ_B" \
  -i "$VID" -vf "fps=3" -q:v 3 "$OUT/err_%03d.jpg"

echo "frames in $OUT: $(ls "$OUT"/*.jpg 2>/dev/null | wc -l)"
echo "READ ORDER: err_* highest-numbered first (the failure), then walk err_* down and into"
echo "ctx_* backwards to find the UPSTREAM action that put the page in the bad state."
