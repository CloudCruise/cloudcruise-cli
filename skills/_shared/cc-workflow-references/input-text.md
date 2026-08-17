# Input: typed description → skeleton

The lightest of the three — the user's words already are the analysis. No frames,
no transcript, no subagent.

## Extraction mode

Setup asks once, whichever modality mix is in play: is this workflow **strict
steps** (a fixed linear sequence) or **the shape of the path to the goal** (real
branching, worth mapping structurally)? For text alone this is usually obvious
from how the user phrases it — a numbered "click this, then this" description is
steps; a description that names conditions, pages, or "depends on" is shape. Ask
only when it's genuinely ambiguous.

## Mapping

- **Strict steps** → one line per move, in order, straight onto `track-linear.md`'s
  `Steps` shape. Decision points the user mentions become steps too ("if it's
  denied, do X instead").
- **Shape of the path** → pages/components the user names or implies, each with a
  goal + done-means, onto `track-branching.md`'s `Skeleton` shape. Gating relations
  the user states explicitly ("only appears if you picked X") are the reveal
  relations; anything not stated is left open for build's census, never guessed.
