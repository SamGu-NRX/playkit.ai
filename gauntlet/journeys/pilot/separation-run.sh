#!/usr/bin/env bash
# separation-run.sh — the separation pilot in one command. Runs the chosen
# suite for the three pilot models (effort high — #102's choice, recorded in
# PILOT.md) plus the free random arm on the same suite, verifies every
# bundle, and prints the six preregistered comparisons with their
# SEPARATED / NOT_SEPARATED verdicts (studies/separation-pilot/analyze.mjs;
# with four bundles every unordered pair is compared — exactly the six
# comparisons PREREGISTRATION.md fixed).
#
# Usage:
#   ./separation-run.sh SUITE CAP_PER_ARM CONCURRENCY [--rehearse]
#
#   SUITE         option file from studies/separation-pilot/outputs/suites/
#                 (required)
#   CAP_PER_ARM   bundle-wide dollar cap per model arm (pilot.sh passes it as
#                 `run --max-usd-total`: it bounds the arm's whole results
#                 bundle across every resume). The random arm costs nothing.
#   CONCURRENCY   worker count per arm
#   --rehearse    point every model arm at its matching loopback stub in
#                 stubs/ (no keys, no spend); the random arm and the
#                 analysis run exactly as live
#
# Every script argument is required with no default: the option, the cap and
# the concurrency are the budget decision's to make (#36 remains open), and
# this script does not choose them.
#
# Optional environment (passed through to pilot.sh):
#   PILOT_REQUESTS_PER_MINUTE  per-arm rate limit (--requests-per-minute)
#   PILOT_MAX_RESUMES          per-arm run-resume loop bound (default 10)
#   SEPARATION_RUN_OUT         output directory override
#
# Model arms and their wires:
#   anthropic/claude-opus-5-5   Anthropic Messages   ANTHROPIC_API_KEY
#   openai/gpt-6-astra          OpenAI Responses     OPENAI_API_KEY
#   openai-chat/gemini-4-argon  Gemini OpenAI-compat GEMINI_API_KEY
#                               (Google's endpoint is the arm's default base)
# A key is read from the arm's own variable only (--api-key-env) and is never
# printed; a rehearsal never needs or sends a real key.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$GAUNTLET_ROOT/cli/gauntlet.js"
ANALYZE="$GAUNTLET_ROOT/studies/separation-pilot/analyze.mjs"
EFFORT="high"

usage() {
  echo "usage: $0 SUITE CAP_PER_ARM CONCURRENCY [--rehearse]" >&2
  exit 2
}

if [[ $# -lt 3 || $# -gt 4 ]]; then usage; fi

SUITE="$1"
CAP_PER_ARM="$2"
CONCURRENCY="$3"
MODE="${4:-}"

if [[ ! -f "$SUITE" ]]; then
  echo "separation-run: SUITE must be a suite manifest file (an option file from studies/separation-pilot/outputs/suites/), got \"$SUITE\"" >&2
  exit 2
fi
# Pin the caller path absolute before any child resolves it differently
# (pilot.sh changes into GAUNTLET_ROOT before running the estimate).
SUITE="$(cd "$(dirname "$SUITE")" && pwd)/$(basename "$SUITE")"
if ! [[ "$CAP_PER_ARM" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk "BEGIN{exit !($CAP_PER_ARM > 0)}"; then
  echo "separation-run: CAP_PER_ARM must be a positive number, got \"$CAP_PER_ARM\"" >&2
  exit 2
fi
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$CONCURRENCY" -lt 1 ]]; then
  echo "separation-run: CONCURRENCY must be a positive integer, got \"$CONCURRENCY\"" >&2
  exit 2
fi
if [[ -n "$MODE" && "$MODE" != "--rehearse" ]]; then usage; fi

if [[ ! -f "$CLI" || ! -f "$ANALYZE" ]]; then
  echo "separation-run: expected to run from a gauntlet checkout (missing cli/gauntlet.js or studies/separation-pilot/analyze.mjs)" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUITE_NAME="$(basename "$SUITE" .json)"
OUT="${SEPARATION_RUN_OUT:-$SCRIPT_DIR/runs/separation-$SUITE_NAME-$STAMP}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

ARMS=(anthropic/claude-opus-5-5 openai/gpt-6-astra openai-chat/gemini-4-argon)

# Rehearsal: one loopback stub per wire, the same contract rehearse.sh uses
# (127.0.0.1 only, accepts any key, never an outbound connection). Fault
# rates overridable with the STUB_*_EVERY variables (0 disables).
STUB_PIDS=()
cleanup() {
  for PID in "${STUB_PIDS[@]:-}"; do
    kill "$PID" 2>/dev/null || true
  done
  for PID in "${STUB_PIDS[@]:-}"; do
    wait "$PID" 2>/dev/null || true
  done
}
trap cleanup EXIT

if [[ "$MODE" == "--rehearse" ]]; then
  RL="${STUB_RATE_LIMIT_EVERY:-5}"
  OL="${STUB_OVERLOAD_EVERY:-13}"
  RF="${STUB_REFUSE_EVERY:-11}"
  TR="${STUB_TRUNCATE_EVERY:-7}"
  # Free ports, not hard-coded ones: a rehearsal that lands on busy ports
  # fails before its first episode (another rehearsal, a dev server, or any
  # listener holds 808x). Allocate one free loopback port per stub up front.
  declare -A STUB_PORT=()
  for ARM in "${ARMS[@]}"; do
    STUB_PORT[$ARM]="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close(() => process.exit(0))})')"
  done
  for ARM in "${ARMS[@]}"; do
    WIRE="${ARM%%/*}"
    PORT="${STUB_PORT[$ARM]}"
    STUB_LOG="$OUT/stub-$PORT.log"
    node "$SCRIPT_DIR/stubs/$WIRE.mjs" --port "$PORT" \
      --rate-limit-every "$RL" --overload-every "$OL" \
      --refuse-every "$RF" --truncate-every "$TR" >"$STUB_LOG" 2>&1 &
    STUB_PIDS+=("$!")
    # Wait for the stub to accept connections (up to ~10 s).
    for _ in $(seq 1 50); do
      if node -e "
        fetch('http://127.0.0.1:$PORT/v1/ping', { method: 'POST', body: '{}' })
          .then(() => process.exit(0))
          .catch((e) => { process.exit(e.cause?.code === 'ECONNREFUSED' ? 1 : 0); });
      " 2>/dev/null; then
        break
      fi
      sleep 0.2
    done
    if ! kill -0 "${STUB_PIDS[-1]}" 2>/dev/null; then
      echo "separation-run: stub for $ARM failed to start — see $STUB_LOG" >&2
      exit 1
    fi
    echo "separation-run: stub $WIRE.mjs on 127.0.0.1:$PORT (pid ${STUB_PIDS[-1]}, log $STUB_LOG)"
  done
fi

# Model arms through pilot.sh: estimate, pre-flight line, capped run
# (resume until complete), verify, leaderboards, estimate-vs-actual.
declare -A ARM_BASE=()
if [[ "$MODE" == "--rehearse" ]]; then
  for ARM in "${ARMS[@]}"; do
    ARM_BASE[$ARM]="http://127.0.0.1:${STUB_PORT[$ARM]}"
  done
fi

# Fail before any arm spends: a missing key for a LATER arm would otherwise
# surface only after the earlier arms have already run and charged their
# estimates. Each pilot.sh checks only its own key when it is reached.
if [[ "$MODE" != "--rehearse" ]]; then
  MISSING=""
  for ARM in "${ARMS[@]}"; do
    case "$ARM" in
      anthropic/*)           KEY_VAR="ANTHROPIC_API_KEY" ;;
      openai-chat/gemini-*)  KEY_VAR="GEMINI_API_KEY" ;;
      openai-chat/*)         KEY_VAR="OPENAI_API_KEY" ;;
      openai/*)              KEY_VAR="OPENAI_API_KEY" ;;
      *)                     KEY_VAR="" ;;
    esac
    if [[ -n "$KEY_VAR" && -z "${!KEY_VAR:-}" ]]; then
      MISSING+="  $KEY_VAR (for $ARM)"$'\n'
    fi
  done
  if [[ -n "$MISSING" ]]; then
    echo "separation-run: refusing to start LIVE arms — missing provider keys:" >&2
    printf '%s' "$MISSING" >&2
    echo "separation-run: export each arm's own key variable (see the header), or pass --rehearse for loopback stubs." >&2
    exit 2
  fi
fi

for ARM in "${ARMS[@]}"; do
  SLUG="$(echo "$ARM" | tr '/' '-')"
  echo
  echo "########## separation-run: arm $ARM ##########"
  PILOT_OUT="$OUT/$SLUG" "$SCRIPT_DIR/pilot.sh" "$SUITE" "$ARM" "$EFFORT" \
    "$CAP_PER_ARM" "$CONCURRENCY" "${ARM_BASE[$ARM]:-}"
done

# Random arm: the bundled seeded random agent on the SAME suite (same seeds)
# — pairing requires episodes. It makes no API calls and costs nothing, so
# no cap applies; the resume loop is the same complete-or-continue contract.
echo
echo "########## separation-run: arm random (free) ##########"
RANDOM_DIR="$OUT/random"
mkdir -p "$RANDOM_DIR"
RANDOM_ARGS=(--suite "$SUITE" --agent random --concurrency "$CONCURRENCY" --out "$RANDOM_DIR/run")
MAX_RESUMES="${PILOT_MAX_RESUMES:-10}"
attempt=1
while :; do
  RESUME_FLAG=""
  if [[ "$attempt" -gt 1 ]]; then RESUME_FLAG="--resume"; fi
  set +e
  node "$CLI" run "${RANDOM_ARGS[@]}" $RESUME_FLAG 2>&1 | tee "$RANDOM_DIR/run-$attempt.console.txt"
  RUN_STATUS="${PIPESTATUS[0]}"
  set -e
  if [[ "$RUN_STATUS" -ne 0 && "$RUN_STATUS" -ne 1 ]]; then
    echo "separation-run: random-arm run failed with exit $RUN_STATUS (see $RANDOM_DIR/run-$attempt.console.txt)" >&2
    exit 1
  fi
  VERDICT="$(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log([r.stopped ?? "done", r.counts.unplayed, r.counts.failed].join(" "));
  ' "$RANDOM_DIR/run/run.json")"
  read -r STOPPED UNPLAYED FAILED <<<"$VERDICT"
  echo "separation-run: random attempt $attempt: stopped=$STOPPED unplayed=$UNPLAYED failed=$FAILED"
  if [[ "$STOPPED" == "error" ]]; then
    echo "separation-run: random arm stopped with an error — see run.json stopReason" >&2
    exit 1
  fi
  # Complete only when nothing is unplayed AND nothing failed (the runner
  # leaves `stopped` unset for ordinary episode errors and says to re-run
  # with --resume to retry them) — an incomplete bundle must not reach the
  # analyzer as if it were done.
  if [[ "$UNPLAYED" == "0" && "$FAILED" == "0" ]]; then
    break
  fi
  attempt=$((attempt + 1))
  if [[ "$attempt" -gt "$MAX_RESUMES" ]]; then
    echo "separation-run: random arm giving up after $MAX_RESUMES invocations with $UNPLAYED unplayed and $FAILED failed episodes" >&2
    exit 1
  fi
done
echo "separation-run: random-arm verify =="
node "$CLI" verify "$RANDOM_DIR/run" 2>&1 | tee "$RANDOM_DIR/verify.console.txt"

# The preregistered analysis: four bundles -> six unordered pairs = the six
# preregistered comparisons; verdicts are data (exit 0 either way).
echo
echo "########## separation-run: preregistered analysis ##########"
BUNDLE_ARGS=()
for ARM in "${ARMS[@]}"; do
  SLUG="$(echo "$ARM" | tr '/' '-')"
  BUNDLE_ARGS+=("$OUT/$SLUG/run")
done
BUNDLE_ARGS+=("$RANDOM_DIR/run")

# Per-arm spend against the cap, before the verdicts.
for ARM in "${ARMS[@]}" random; do
  if [[ "$ARM" == "random" ]]; then DIR="$RANDOM_DIR/run"; else DIR="$OUT/$(echo "$ARM" | tr '/' '-')/run"; fi
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/run.json", "utf8"));
    const l = r.ledger;
    console.log(`separation-run: ${process.argv[2]}: stopped=${r.stopped ?? "done"} ledgerTotalUsd=${l.totalUsd} (cap ${l.cap ?? "none"}) keptUsd=${l.keptUsd} unwoundUsd=${l.unwoundUsd} unwoundCalls=${l.unwoundCalls}`);
  ' "$DIR" "$ARM"
done

node "$ANALYZE" "${BUNDLE_ARGS[@]}" 2>&1 | tee "$OUT/analysis.console.txt"

echo
echo "separation-run: COMPLETE — suite=$SUITE_NAME cap=\$$CAP_PER_ARM per model arm (bundle-wide), concurrency=$CONCURRENCY, effort=$EFFORT${MODE:+, $MODE}"
echo "separation-run: bundles in $OUT; analysis transcript in $OUT/analysis.console.txt"
