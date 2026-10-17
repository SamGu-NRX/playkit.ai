#!/usr/bin/env bash
# pilot.sh — run the frontier pilot for ONE model, end to end, with a dollar cap.
#
# Usage:
#   ./pilot.sh MODEL EFFORT MAX_USD [BASE_URL]
#
#   MODEL     provider/model, e.g. anthropic/claude-opus-5-5, openai/gpt-6-astra,
#             openai-chat/gemini-4-argon
#   EFFORT    reasoning effort: low | medium | high | xhigh | max (validated
#             against the model's capability row by the agent layer)
#   MAX_USD   hard dollar cap for gauntlet run (per invocation; see PILOT.md)
#   BASE_URL  optional API root. WITHOUT it the run calls the real provider and
#             spends real money — it then requires the provider's API key in the
#             environment and refuses to start without it. Every rehearsal passes
#             a loopback stub URL (127.0.0.1 only), so nothing is spent.
#
# Steps, in order (this is the run sequence from reports/release/RUN-SEQUENCE.md,
# capped and per-model):
#   1. gauntlet suite build --split public --seeds-per-tier 1   (current tree;
#      the job count is printed — the tree has grown since the release board)
#   2. gauntlet estimate            (local probe episodes, no API calls)
#   3. gauntlet run --max-usd MAX_USD, resuming with --resume until the bundle
#      completes (each resume re-verifies finished trajectories and replays only
#      what is missing)
#   4. gauntlet verify              (replay-verify every trajectory in the bundle)
#   5. gauntlet leaderboard under all three scoring profiles
#   6. gauntlet estimate --against  (what the run actually cost vs the estimate)
#
# Outputs land in journeys/pilot/runs/<model>-<timestamp>/ (override with
# PILOT_OUT). Every console transcript is teed there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$GAUNTLET_ROOT/cli/gauntlet.js"
PRICES="$GAUNTLET_ROOT/reports/release/prices.frontier.json"

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 MODEL EFFORT MAX_USD [BASE_URL]" >&2
  exit 2
fi

MODEL="$1"
EFFORT="$2"
MAX_USD="$3"
BASE_URL="${4:-}"

case "$MODEL" in
  anthropic/*|openai/*|openai-chat/*) ;;
  *) echo "pilot: MODEL must be provider/model with provider anthropic, openai or openai-chat, got \"$MODEL\"" >&2; exit 2 ;;
esac
PROVIDER="${MODEL%%/*}"

case "$EFFORT" in
  low|medium|high|xhigh|max) ;;
  *) echo "pilot: EFFORT must be low, medium, high, xhigh or max, got \"$EFFORT\"" >&2; exit 2 ;;
esac

if ! [[ "$MAX_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk "BEGIN{exit !($MAX_USD > 0)}"; then
  echo "pilot: MAX_USD must be a positive number, got \"$MAX_USD\"" >&2
  exit 2
fi

if [[ ! -f "$CLI" || ! -f "$PRICES" ]]; then
  echo "pilot: expected to run from a gauntlet checkout (missing cli/gauntlet.js or reports/release/prices.frontier.json)" >&2
  exit 2
fi

# API keys: a live run (no BASE_URL) requires the provider key in the
# environment and refuses to start without it — never half-start a paid run.
# A rehearsal (BASE_URL on 127.0.0.1) injects a dummy key only if none is set;
# the stub accepts anything, and no real key is ever needed or sent anywhere.
KEY_ENV="OPENAI_API_KEY"
case "$PROVIDER" in
  anthropic) KEY_ENV="ANTHROPIC_API_KEY" ;;
  openai|openai-chat) KEY_ENV="OPENAI_API_KEY" ;;
esac
if [[ -z "$BASE_URL" ]]; then
  if [[ -z "${!KEY_ENV:-}" ]]; then
    echo "pilot: refusing to start a LIVE run: \$$KEY_ENV is not set (the run would call the real provider). Export the key, or pass a BASE_URL to rehearse against a stub." >&2
    exit 2
  fi
  echo "pilot: LIVE run against the real provider — real spend, capped at \$${MAX_USD} per invocation."
else
  case "$BASE_URL" in
    http://127.0.0.1:*|http://localhost:*) : ;;
    *) echo "pilot: warning: BASE_URL is not a loopback address: $BASE_URL" >&2 ;;
  esac
  export "$KEY_ENV=${!KEY_ENV:-stub-key-not-real}"
  echo "pilot: rehearsal against $BASE_URL (stub; no external calls, no spend)."
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SLUG="$(echo "$MODEL" | tr '/' '-')"
OUT="${PILOT_OUT:-$SCRIPT_DIR/runs/$SLUG-$STAMP}"
mkdir -p "$OUT"
echo "pilot: outputs in $OUT"

cd "$GAUNTLET_ROOT"

# 1. Suite: built on the current tree. Report what the tree now carries.
SUITE="$OUT/suite.pilot.json"
echo "== [1/6] suite build --split public --seeds-per-tier 1 =="
node "$CLI" suite build --split public --seeds-per-tier 1 --out "$SUITE" | tee "$OUT/suite-build.console.txt"
JOB_COUNT="$(node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  let n = 0;
  for (const g of s.games) for (const t of g.tiers) n += t.seeds.length;
  console.log(`${s.games.length} games, ${n} jobs`);
' "$SUITE")"
echo "pilot: current-tree public split: $JOB_COUNT"

# 2. Estimate: local probe episodes and tier pars; no API calls, no spend.
#
# Known harness hang on this base: with the pre-burst13 GTP client (burst13's
# stale-reply fix is still an unmerged draft), the estimate's go-ladder probe
# episodes can wedge — gnugo children blocked, estimate never exits after
# writing its outputs. Bounded with a timeout; if the outputs exist when the
# timeout fires, the step counts as complete with a loud warning. For a live
# pilot the estimate numbers are only ever a scoping aid, never a gate.
echo "== [2/6] estimate =="
ESTIMATE_TIMEOUT_SECS="${ESTIMATE_TIMEOUT_SECS:-900}"
set +e
timeout --signal=TERM --kill-after=10 "$ESTIMATE_TIMEOUT_SECS" \
  node "$CLI" estimate --suite "$SUITE" --agent "model:$MODEL" --prices "$PRICES" \
  --out "$OUT/estimate" 2>&1 | tee "$OUT/estimate.console.txt"
EST_STATUS="${PIPESTATUS[0]}"
set -e
case "$EST_STATUS" in
  0) : ;;
  124|137|143)
    if [[ -f "$OUT/estimate/estimate.json" ]]; then
      echo "pilot: WARNING: estimate did not exit (status $EST_STATUS after ${ESTIMATE_TIMEOUT_SECS}s) but its outputs are present — known go-ladder probe hang on this base (pre-burst13 GTP client); continuing with the written estimate." >&2
      # The timeout killed the estimate's node process, not its engine
      # children; orphaned gnugo GTP instances (parent pid 1) would idle
      # forever, so reap exactly those.
      for OPID in $(ps -eo pid,ppid,args | awk '$2 == 1 && /gnugo --mode gtp/ {print $1}'); do
        kill "$OPID" 2>/dev/null || true
      done
    else
      echo "pilot: estimate timed out after ${ESTIMATE_TIMEOUT_SECS}s with no outputs — see $OUT/estimate.console.txt" >&2
      exit 1
    fi ;;
  *)
    echo "pilot: estimate failed with exit $EST_STATUS — see $OUT/estimate.console.txt" >&2
    exit 1 ;;
esac

# 3. Run, resuming until the bundle completes. A run invocation that reaches a
# cap exits 1 with run.json stopped="budget"; each resume re-verifies what is
# already in the bundle and replays only the missing episodes. The dollar cap
# is enforced per invocation (settled spend counts this invocation's calls);
# see PILOT.md for what that means for the worst case.
echo "== [3/6] run --max-usd $MAX_USD (resume until complete) =="
RUN_ARGS=(--suite "$SUITE" --agent "model:$MODEL" --reasoning-effort "$EFFORT"
  --max-usd "$MAX_USD" --prices "$PRICES" --out "$OUT/run")
if [[ -n "$BASE_URL" ]]; then RUN_ARGS+=(--base-url "$BASE_URL"); fi

MAX_RESUMES="${PILOT_MAX_RESUMES:-10}"
attempt=1
while :; do
  RESUME_FLAG=""
  if [[ "$attempt" -gt 1 ]]; then RESUME_FLAG="--resume"; fi
  # Optional wall-clock bound per invocation (RUN_TIMEOUT_SECS, 0 = none;
  # rehearsals set it). A killed invocation exits 124/143 and leaves the
  # bundle exactly as --resume expects it; if one episode wedges every
  # attempt, the resume cap below aborts with that message.
  TIMEOUT_CMD=()
  RUN_TIMEOUT_SECS="${RUN_TIMEOUT_SECS:-0}"
  if [[ "$RUN_TIMEOUT_SECS" -gt 0 ]]; then
    TIMEOUT_CMD=(timeout --signal=TERM --kill-after=10 "$RUN_TIMEOUT_SECS")
  fi
  set +e
  "${TIMEOUT_CMD[@]}" node "$CLI" run "${RUN_ARGS[@]}" $RESUME_FLAG 2>&1 | tee "$OUT/run-$attempt.console.txt"
  RUN_STATUS="${PIPESTATUS[0]}"
  set -e
  if [[ "$RUN_STATUS" -eq 124 || "$RUN_STATUS" -eq 137 || "$RUN_STATUS" -eq 143 ]]; then
    echo "pilot: run invocation $attempt hit the ${RUN_TIMEOUT_SECS}s wall clock (status $RUN_STATUS) — resuming from the bundle"
    RUN_STATUS=1
  fi
  if [[ "$RUN_STATUS" -ne 0 && "$RUN_STATUS" -ne 1 ]]; then
    echo "pilot: gauntlet run failed with exit $RUN_STATUS (see $OUT/run-$attempt.console.txt)" >&2
    exit 1
  fi
  VERDICT="$(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log([r.stopped ?? "done", r.counts.unplayed, r.counts.failed, r.total.spendUsd].join(" "));
  ' "$OUT/run/run.json")"
  read -r STOPPED UNPLAYED FAILED SPEND <<<"$VERDICT"
  echo "pilot: attempt $attempt: stopped=$STOPPED unplayed=$UNPLAYED failed=$FAILED bundleSpendUsd=$SPEND"
  if [[ "$STOPPED" == "error" ]]; then
    echo "pilot: run stopped with an error — see run.json stopReason" >&2
    exit 1
  fi
  if [[ "$STOPPED" == "done" || "$UNPLAYED" == "0" ]]; then
    break
  fi
  attempt=$((attempt + 1))
  if [[ "$attempt" -gt "$MAX_RESUMES" ]]; then
    echo "pilot: giving up after $MAX_RESUMES invocations with $UNPLAYED episodes unplayed (raise PILOT_MAX_RESUMES or the cap)" >&2
    exit 1
  fi
  echo "pilot: cap bound — resuming ($((MAX_RESUMES - attempt + 1)) invocations left)"
done

# 4. Verify: replay-verify every trajectory in the bundle.
echo "== [4/6] verify =="
node "$CLI" verify "$OUT/run" 2>&1 | tee "$OUT/verify.console.txt"

# 5. Leaderboard under all three scoring profiles. Decision #36 (the floor
# profile) is Sam's open call — publishing all three keeps that decision open.
# Profiles fail independently: a stale committed scoring baseline makes the
# chance-rescaling profiles refuse a tier with an actionable error (the
# version-refusal is correct behavior; the recal is sibling-owned). One
# profile refusing must not lose the other two.
echo "== [5/6] leaderboard (rhae-v1, chance-adjusted, squared-outcome) =="
LEADERBOARD_FAILED=""
for PROFILE in rhae-v1 chance-adjusted squared-outcome; do
  set +e
  node "$CLI" leaderboard --suite "$SUITE" --scoring-profile "$PROFILE" \
    --out "$OUT/leaderboard/$PROFILE" "$OUT/run" 2>&1 | tee "$OUT/leaderboard-$PROFILE.console.txt"
  LB_STATUS="${PIPESTATUS[0]}"
  set -e
  if [[ "$LB_STATUS" -ne 0 ]]; then
    LEADERBOARD_FAILED="$LEADERBOARD_FAILED $PROFILE"
    echo "pilot: WARNING: leaderboard profile $PROFILE failed (exit $LB_STATUS) — see $OUT/leaderboard-$PROFILE.console.txt; continuing" >&2
  fi
done

# 6. Estimate vs actual: how the run's calls, tokens and dollars landed
# against the estimate's low and high figures. Same non-exit hang as step 2
# (the comparison is fully printed to the console, then the process wedges) —
# bounded by a timeout, with the printed Total table counting as the
# deliverable.
echo "== [6/6] estimate --against =="
ESTIMATE_AGAINST_TIMEOUT_SECS="${ESTIMATE_AGAINST_TIMEOUT_SECS:-600}"
set +e
timeout --signal=TERM --kill-after=10 "$ESTIMATE_AGAINST_TIMEOUT_SECS" \
  node "$CLI" estimate --suite "$SUITE" --agent "model:$MODEL" --prices "$PRICES" \
  --against "$OUT/run" 2>&1 | tee "$OUT/estimate-against.console.txt"
ESTA_STATUS="${PIPESTATUS[0]}"
set -e
case "$ESTA_STATUS" in
  0) : ;;
  124|137|143)
    if grep -q '^| \*\*Total\*\*' "$OUT/estimate-against.console.txt"; then
      echo "pilot: WARNING: estimate --against printed its comparison but did not exit (status $ESTA_STATUS after ${ESTIMATE_AGAINST_TIMEOUT_SECS}s) — same hang as the estimate step; the transcript above is complete." >&2
    else
      echo "pilot: estimate --against timed out with no comparison table — see $OUT/estimate-against.console.txt" >&2
      exit 1
    fi ;;
  *)
    echo "pilot: estimate --against failed with exit $ESTA_STATUS — see $OUT/estimate-against.console.txt" >&2
    exit 1 ;;
esac

echo "pilot: COMPLETE — model=$MODEL effort=$EFFORT cap=\$$MAX_USD bundleSpendUsd=$SPEND outputs in $OUT"
