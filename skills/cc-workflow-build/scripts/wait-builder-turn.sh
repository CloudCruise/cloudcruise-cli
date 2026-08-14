#!/usr/bin/env bash
# wait-builder-turn.sh — block until ONE builder turn settles, then print its report.
#
# The build loop dispatches a task to the builder agent and waits for the turn to
# end before reading the result. That wait is a `cloudcruise builder status` poll
# loop plus the exit-0 ambiguity (completed vs idle vs ended) plus digging the
# assistant's report out of `builder messages` — fragile control flow that would
# otherwise be hand-rolled per component. This wraps all of it behind one exit-code
# contract.
#
# Invoke with an explicit interpreter (the repo ships skill scripts non-executable):
#   bash <skill>/scripts/wait-builder-turn.sh --conversation <id> [auth flags] \
#       [--poll-seconds N] [--timeout-seconds N]
#
# Auth flags are forwarded verbatim to `cloudcruise`: --profile, --base-url,
# --app-url, --workspace-id. Auth may also come from CLOUDCRUISE_* env or the
# default profile, exactly as for a bare `cloudcruise builder status`.
#
# Defaults: --poll-seconds 15, --timeout-seconds 1800 (30 min). Reads nothing from
# stdin.
#
# Exit codes — the caller switches on these; it never parses stdout to decide:
#   0    turn completed; stdout is ONLY the final assistant report (plain text)
#   7    awaiting-human-input; stdout is the status JSON (carries .humanInput)
#   8    agent-errored; stdout is the status JSON
#   124  local polling timed out (--timeout-seconds elapsed, turn still processing)
#   2    bad arguments to THIS script, or a missing prerequisite (cloudcruise / jq)
#   1    completed-but-no-report, idle, ended, unknown status, or messages fetch failed
#   *    any other `cloudcruise` exit code (3 auth, 4 not-found, 5 ambiguous,
#        6 busy, 10 no-browser, 11 skills-incompatible, ...) passed through verbatim
#
# One turn only. Exit 0 means this ONE turn finished — the caller still grades the
# component's done-means invariant, advances the plan marker, and dispatches the
# next component. Human-input response and agent-error recovery stay in the caller.

set -u

readonly PROG="wait-builder-turn"

usage() {
  cat >&2 <<'EOF'
Usage: bash wait-builder-turn.sh --conversation <id> [--profile <name>]
         [--base-url <url>] [--app-url <url>] [--workspace-id <id>]
         [--poll-seconds <int>] [--timeout-seconds <int>]

Blocks until one builder turn settles. Exit code is the outcome:
  0 completed (stdout=report)  7 awaiting-human-input  8 agent-errored
  124 timeout  2 bad args/missing prereq  1 no-report/idle/ended
  other = underlying `cloudcruise` exit code, passed through.
EOF
}

# Client-side usage error → exit 2 (matches the CLI's own BAD_ARGS code).
die_usage() {
  printf '%s: %s\n' "$PROG" "$1" >&2
  usage
  exit 2
}

# ── Arguments ──────────────────────────────────────────────────────────────
conversation=""
profile=""
base_url=""
app_url=""
workspace_id=""
poll_seconds=15
timeout_seconds=1800

# Require the next token to exist, so `--conversation` at end-of-args fails loudly
# instead of swallowing the following flag as its value.
need_value() {
  # $1 = flag name, $2 = remaining arg count after the flag
  if [ "$2" -lt 1 ]; then
    die_usage "$1 requires a value"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --conversation)   need_value "$1" $(($# - 1)); conversation="$2";   shift 2 ;;
    --profile)        need_value "$1" $(($# - 1)); profile="$2";        shift 2 ;;
    --base-url)       need_value "$1" $(($# - 1)); base_url="$2";       shift 2 ;;
    --app-url)        need_value "$1" $(($# - 1)); app_url="$2";        shift 2 ;;
    --workspace-id)   need_value "$1" $(($# - 1)); workspace_id="$2";   shift 2 ;;
    --poll-seconds)   need_value "$1" $(($# - 1)); poll_seconds="$2";   shift 2 ;;
    --timeout-seconds) need_value "$1" $(($# - 1)); timeout_seconds="$2"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    --) shift; break ;;
    -*) die_usage "unknown flag: $1" ;;
    *)  die_usage "unexpected argument: $1" ;;
  esac
done

case "$poll_seconds" in
  ''|*[!0-9]*) die_usage "--poll-seconds must be a non-negative integer" ;;
esac
case "$timeout_seconds" in
  ''|*[!0-9]*) die_usage "--timeout-seconds must be a non-negative integer" ;;
esac

command -v cloudcruise >/dev/null 2>&1 || die_usage "cloudcruise not found on PATH"
command -v jq >/dev/null 2>&1 || die_usage "jq not found on PATH"

# Auth/target flags forwarded to every `cloudcruise` call. Only the ones actually
# supplied are passed; the rest fall back to CLOUDCRUISE_* env / the default profile.
cc_args=()
[ -n "$conversation" ] && cc_args+=(--conversation "$conversation")
[ -n "$profile" ]      && cc_args+=(--profile "$profile")
[ -n "$base_url" ]     && cc_args+=(--base-url "$base_url")
[ -n "$app_url" ]      && cc_args+=(--app-url "$app_url")
[ -n "$workspace_id" ] && cc_args+=(--workspace-id "$workspace_id")

# Scratch file for each call's stderr, so polling emits no transcript noise and a
# genuine CLI failure's stderr is still forwarded intact.
err_file="$(mktemp "${TMPDIR:-/tmp}/${PROG}.XXXXXX")" || {
  printf '%s: could not create a temp file\n' "$PROG" >&2
  exit 1
}
trap 'rm -f "$err_file"' EXIT

# ── Report extraction ──────────────────────────────────────────────────────
# On a completed turn, the report is the last `role:assistant` message that is not
# reasoning and has non-empty text (per the cloudcruise skill's message contract).
print_report_or_fail() {
  local msg_out mrc report
  # `${arr[@]+...}` guard keeps this bash-3.2 safe when cc_args is empty.
  msg_out="$(cloudcruise builder messages ${cc_args[@]+"${cc_args[@]}"} --limit 20 2>"$err_file")"
  mrc=$?
  if [ "$mrc" -ne 0 ]; then
    cat "$err_file" >&2
    printf '%s: turn completed but `builder messages` failed (exit %s)\n' "$PROG" "$mrc" >&2
    exit 1
  fi
  report="$(printf '%s' "$msg_out" | jq -r '
    [ (.messages // .)[]?
      | select(.role == "assistant")
      | select(.type != "reasoning")
      | select((.text // "") | length > 0)
    ] | last | .text // empty' 2>/dev/null)"
  if [ -z "$report" ]; then
    printf '%s: turn completed but no assistant report found in the last 20 messages\n' "$PROG" >&2
    exit 1
  fi
  printf '%s\n' "$report"
  exit 0
}

# ── Poll loop ──────────────────────────────────────────────────────────────
# SECONDS is bash's monotonic wall-clock counter; the deadline bounds total wait
# including each status call's own latency.
deadline=$((SECONDS + timeout_seconds))

while :; do
  status_out="$(cloudcruise builder status ${cc_args[@]+"${cc_args[@]}"} 2>"$err_file")"
  rc=$?

  case "$rc" in
    0)
      # Exit 0 is completed OR idle OR ended (src/core/exit.ts). Only completed is
      # a real turn end; the others must not masquerade as one.
      status="$(printf '%s' "$status_out" | jq -r '.status // empty' 2>/dev/null)"
      case "$status" in
        completed)
          print_report_or_fail
          ;;
        idle)
          printf '%s\n' "$status_out"
          printf '%s: builder conversation is idle; no completed turn was observed\n' "$PROG" >&2
          exit 1
          ;;
        ended)
          printf '%s\n' "$status_out"
          printf '%s: builder conversation ended before a turn completed\n' "$PROG" >&2
          exit 1
          ;;
        *)
          # Fail closed: exit 0 with a status the CLI taxonomy does not map here.
          printf '%s\n' "$status_out"
          printf '%s: unexpected status %s after a clean status exit\n' "$PROG" "${status:-<none>}" >&2
          exit 1
          ;;
      esac
      ;;
    7)
      printf '%s\n' "$status_out"
      exit 7
      ;;
    8)
      printf '%s\n' "$status_out"
      exit 8
      ;;
    9)
      # Processing (or an unrecognized transient status): tick and re-arm.
      now=$SECONDS
      if [ "$now" -ge "$deadline" ]; then
        printf '%s: builder polling timed out after %s seconds\n' "$PROG" "$timeout_seconds" >&2
        exit 124
      fi
      remaining=$((deadline - now))
      sleep_for=$poll_seconds
      [ "$sleep_for" -gt "$remaining" ] && sleep_for=$remaining
      sleep "$sleep_for"
      ;;
    *)
      # A genuine CLI failure (auth, session, busy, no-browser, ...). Forward its
      # stderr and exit code unchanged so the caller sees the real cause.
      cat "$err_file" >&2
      exit "$rc"
      ;;
  esac
done
