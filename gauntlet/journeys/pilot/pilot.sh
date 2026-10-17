#!/usr/bin/env bash
# pilot.sh — run the frontier pilot for ONE model on ONE committed suite,
# end to end, under a bundle-wide dollar cap.
#
# Usage:
#   ./pilot.sh SUITE MODEL EFFORT CAP_USD CONCURRENCY [BASE_URL]
#
#   SUITE        suite manifest to run — an option file from
#                studies/separation-pilot/outputs/suites/ (required; this
#                script never builds a suite silently)
#   MODEL        provider/model, e.g. anthropic/claude-opus-5-5,
#                openai/gpt-6-astra, openai-chat/gemini-4-argon
#   EFFORT       reasoning effort: low | medium | high | xhigh | max
#                (validated against the model's capability row)
#   CAP_USD      BUNDLE-WIDE dollar cap, passed as `run --max-usd-total`: it
#                bounds the whole results bundle across every resume, so
#                resuming cannot multiply spend (PILOT.md, "The dollar cap,
#                precisely", documents the cap-stop rule that
#                runs/cap-unwind.test.js pins)
#   CONCURRENCY  worker count for `gauntlet run`
#   BASE_URL     optional API root. ON LOOPBACK (http://127.0.0.1:* or
#                http://localhost:*) the run is a rehearsal: a dummy key is
#                injected when none is set, and nothing is spent. ANY OTHER
#                URL IS LIVE — it requires the provider's own key variable in
#                the environment and is never called a rehearsal. Without
#                BASE_URL the run is live against the provider's public API.
#
# Provider keys — the arm's own variable, never another provider's:
#   anthropic/*           ANTHROPIC_API_KEY  (default base https://api.anthropic.com)
#   openai/*              OPENAI_API_KEY     (default base https://api.openai.com)
#   openai-chat/gemini-*  GEMINI_API_KEY     (default base Google's OpenAI-
#                         compatible endpoint, see GEMINI_BASE_URL below)
#   openai-chat/<other>   OPENAI_API_KEY     (no default base: a chat-
#                         completions server is self-hosted, so a BASE_URL
#                         is required for a live run of a non-Gemini model)
# The variable is passed to the agent with --api-key-env, so the key is read
# at call time from the arm's own variable and is never printed. In a
# rehearsal a dummy value is injected only if the arm's own variable is
# unset; the loopback stub accepts anything.
#
# Optional environment:
#   PILOT_REQUESTS_PER_MINUTE  passed through as --requests-per-minute
#   PILOT_MAX_RESUMES          run-resume loop bound (default 10)
#   PILOT_OUT                  output directory override
#
# Steps (RUN-SEQUENCE.md order, capped, per model):
#   1. estimate --no-probes   (local; no API calls, no engines, no spend)
#      then the pre-flight line: job count, the estimate's high dollars,
#      the bundle-wide cap, and the worst-case paid-but-discarded amount at
#      a cap stop — printed BEFORE the first paid call
#   2. run --max-usd-total CAP_USD --concurrency CONCURRENCY, resuming with
#      --resume until the bundle completes
#   3. verify                 (replay-verify every trajectory in the bundle)
#   4. leaderboard under all three scoring profiles (fail independently)
#   5. estimate --no-probes --against (actual vs estimate)
#
# Outputs land in journeys/pilot/runs/<model>-<timestamp>/ (override with
# PILOT_OUT). Every console transcript is teed there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$GAUNTLET_ROOT/cli/gauntlet.js"
PRICES="$GAUNTLET_ROOT/reports/release/prices.frontier.json"
GEMINI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

usage() {
  echo "usage: $0 SUITE MODEL EFFORT CAP_USD CONCURRENCY [BASE_URL]" >&2
  exit 2
}

if [[ $# -lt 5 || $# -gt 6 ]]; then usage; fi

SUITE="$1"
MODEL="$2"
EFFORT="$3"
CAP_USD="$4"
CONCURRENCY="$5"
BASE_URL="${6:-}"

if [[ ! -f "$SUITE" ]]; then
  echo "pilot: SUITE must be a suite manifest file (an option file from studies/separation-pilot/outputs/suites/), got \"$SUITE\"" >&2
  exit 2
fi
# Absolutize before the script changes directory: every CLI call below runs
# from GAUNTLET_ROOT, so a caller-relative SUITE would otherwise resolve
# under gauntlet/ and not where the caller checked it.
SUITE="$(cd "$(dirname "$SUITE")" && pwd)/$(basename "$SUITE")"
case "$MODEL" in
  anthropic/*|openai/*|openai-chat/*) ;;
  *) echo "pilot: MODEL must be provider/model with provider anthropic, openai or openai-chat, got \"$MODEL\"" >&2; exit 2 ;;
esac
PROVIDER="${MODEL%%/*}"

case "$EFFORT" in
  low|medium|high|xhigh|max) ;;
  *) echo "pilot: EFFORT must be low, medium, high, xhigh or max, got \"$EFFORT\"" >&2; exit 2 ;;
esac

if ! [[ "$CAP_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk "BEGIN{exit !($CAP_USD > 0)}"; then
  echo "pilot: CAP_USD must be a positive number, got \"$CAP_USD\"" >&2
  exit 2
fi
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$CONCURRENCY" -lt 1 ]]; then
  echo "pilot: CONCURRENCY must be a positive integer, got \"$CONCURRENCY\"" >&2
  exit 2
fi

if [[ ! -f "$CLI" || ! -f "$PRICES" ]]; then
  echo "pilot: expected to run from a gauntlet checkout (missing cli/gauntlet.js or reports/release/prices.frontier.json)" >&2
  exit 2
fi

# The arm's own key variable — never another provider's, so a key is never
# read from (let alone sent to) a host it does not belong to.
case "$MODEL" in
  anthropic/*)          KEY_ENV="ANTHROPIC_API_KEY" ;;
  openai/*)             KEY_ENV="OPENAI_API_KEY" ;;
  openai-chat/gemini-*) KEY_ENV="GEMINI_API_KEY" ;;
  openai-chat/*)        KEY_ENV="OPENAI_API_KEY" ;;
esac

# Live or rehearsal: a run is a rehearsal only on a loopback base URL.
# Any other URL is live. Without BASE_URL: live at the provider's default.
MODE="live"
if [[ -n "$BASE_URL" ]]; then
  case "$BASE_URL" in
    http://127.0.0.1:*|http://localhost:*) MODE="rehearsal" ;;
    *) MODE="live" ;;
  esac
fi

if [[ "$MODE" == "live" ]]; then
  if [[ -z "${!KEY_ENV:-}" ]]; then
    echo "pilot: refusing to start a LIVE run: \$$KEY_ENV is not set (the run would call the real provider and spend real money). Export the provider's own key variable, or point BASE_URL at a 127.0.0.1 stub." >&2
    exit 2
  fi
  if [[ "$PROVIDER" == "openai-chat" && -z "$BASE_URL" ]]; then
    case "$MODEL" in
      openai-chat/gemini-*) BASE_URL="$GEMINI_BASE_URL" ;;
      *) echo "pilot: refusing to start a LIVE run: openai-chat needs an API root — $MODEL is not a Gemini id, so there is no default base URL. Pass BASE_URL." >&2; exit 2 ;;
    esac
  fi
  echo "pilot: LIVE run — model=$MODEL suite=$SUITE cap=\$$CAP_USD bundle-wide, concurrency=$CONCURRENCY. Real spend, bounded by the cap."
else
  export "$KEY_ENV=${!KEY_ENV:-stub-key-not-real}"
  echo "pilot: rehearsal against $BASE_URL (loopback stub; no external calls, no spend)."
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SLUG="$(echo "$MODEL" | tr '/' '-')"
OUT="${PILOT_OUT:-$SCRIPT_DIR/runs/$SLUG-$STAMP}"
mkdir -p "$OUT"
# Same contract as SUITE: the caller gave the path relative to the caller's
# directory — pin it absolute before cd, so every CLI call writes where the
# line above just reported.
OUT="$(cd "$OUT" && pwd)"
echo "pilot: outputs in $OUT"

cd "$GAUNTLET_ROOT"

# 1. Estimate: --no-probes keeps it local and engine-free — no API calls, no
# spend, no go-ladder GTP sessions. For a committed separation-pilot option
# the committed per-model estimate in studies/separation-pilot/outputs/
# estimates/ carries the same basis; this re-derives it for this tree.
echo "== [1/5] estimate --no-probes =="
node "$CLI" estimate --suite "$SUITE" --agent "model:$MODEL" --prices "$PRICES" \
  --no-probes --out "$OUT/estimate" 2>&1 | tee "$OUT/estimate.console.txt"

# Pre-flight: the numbers that matter, printed BEFORE the first paid call.
# Worst case paid-but-discarded at a cap stop: the committed spend of the
# episodes still in flight — bounded by min(concurrency x per-episode spend,
# cap); per-episode spend here is the estimate's high side per job. The
# ledger total itself never passes the cap (runs/cap-unwind.test.js).
JOBS="$(node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  let n = 0;
  for (const g of s.games) for (const t of g.tiers) n += t.seeds.length;
  console.log(n);
' "$SUITE")"
GAMES_COUNT="$(node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(s.games.length);
' "$SUITE")"
read -r EST_HIGH PER_EP_HIGH DISCARDED <<<"$(node -e '
  const e = JSON.parse(require("node:fs").readFileSync(process.argv[2] + "/estimate/estimate.json", "utf8"));
  // The priciest job high side, not the suite average: at a cap stop the
  // in-flight workers may ALL be running expensive jobs, so the discarded
  // bound must use the largest per-episode estimate-high (average understates
  // it — committed pilot-1seed OpenAI: average $1.42/job, priciest $14.06).
  // These are estimates from measured runs, not enforced limits.
  const highs = (e.jobs ?? []).map((j) => j.usdHigh).filter((x) => typeof x === "number" && Number.isFinite(x));
  const perEpHigh = highs.length ? Math.max(...highs) : null;
  const discarded = perEpHigh === null ? null : Math.min(process.argv[1] * perEpHigh, process.argv[3]);
  const fmt = (x) => (x === null ? "unknown" : x.toFixed(2));
  console.log((e.totals.usdHigh ?? 0).toFixed(2), perEpHigh === null ? "unknown" : perEpHigh.toFixed(4), fmt(discarded));
' "$CONCURRENCY" "$OUT" "$CAP_USD")"
echo "pilot: PRE-FLIGHT — suite: $GAMES_COUNT games, $JOBS jobs | estimate high: \$$EST_HIGH per arm | cap: \$$CAP_USD bundle-wide (--max-usd-total; resumes cannot multiply spend) | concurrency: $CONCURRENCY | worst case paid-but-discarded at a cap stop: <= \$$DISCARDED (estimate basis: min(concurrency x the priciest job's estimate-high, cap); estimates from measured runs, not enforced limits; see PILOT.md)"

# 2. Run, resuming until the bundle completes. The cap is BUNDLE-WIDE
# (--max-usd-total): the bundle's spend.jsonl ledger records every paid call
# across invocations, and the recorded total never passes the cap. A resume
# that can no longer afford one call stops with zero new calls — reported
# loudly rather than spun.
echo "== [2/5] run --max-usd-total $CAP_USD --concurrency $CONCURRENCY (resume until complete) =="
RUN_ARGS=(--suite "$SUITE" --agent "model:$MODEL" --reasoning-effort "$EFFORT"
  --max-usd-total "$CAP_USD" --prices "$PRICES" --concurrency "$CONCURRENCY"
  --api-key-env "$KEY_ENV" --out "$OUT/run")
if [[ -n "$BASE_URL" ]]; then RUN_ARGS+=(--base-url "$BASE_URL"); fi
if [[ -n "${PILOT_REQUESTS_PER_MINUTE:-}" ]]; then
  RUN_ARGS+=(--requests-per-minute "$PILOT_REQUESTS_PER_MINUTE")
fi

MAX_RESUMES="${PILOT_MAX_RESUMES:-10}"
attempt=1
while :; do
  RESUME_FLAG=""
  if [[ "$attempt" -gt 1 ]]; then RESUME_FLAG="--resume"; fi
  set +e
  node "$CLI" run "${RUN_ARGS[@]}" $RESUME_FLAG 2>&1 | tee "$OUT/run-$attempt.console.txt"
  RUN_STATUS="${PIPESTATUS[0]}"
  set -e
  if [[ "$RUN_STATUS" -ne 0 && "$RUN_STATUS" -ne 1 ]]; then
    echo "pilot: gauntlet run failed with exit $RUN_STATUS (see $OUT/run-$attempt.console.txt)" >&2
    exit 1
  fi
  VERDICT="$(node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    console.log([r.stopped ?? "done", r.counts.unplayed, r.counts.failed, r.calls, r.total.spendUsd, r.ledger.totalUsd, r.ledger.cap].join(" "));
  ' "$OUT/run/run.json")"
  read -r STOPPED UNPLAYED FAILED ATTEMPT_CALLS BUNDLE_SPEND LEDGER_TOTAL LEDGER_CAP <<<"$VERDICT"
  echo "pilot: attempt $attempt: stopped=$STOPPED unplayed=$UNPLAYED failed=$FAILED invocationCalls=$ATTEMPT_CALLS bundleSpendUsd=$BUNDLE_SPEND ledgerTotalUsd=$LEDGER_TOTAL (cap \$$LEDGER_CAP)"
  if [[ "$STOPPED" == "error" ]]; then
    echo "pilot: run stopped with an error — see run.json stopReason" >&2
    exit 1
  fi
  # Complete only when nothing is unplayed AND nothing failed. The runner
  # leaves `stopped` unset for an ordinary episode error and says to re-run
  # with --resume to retry it — so failed episodes loop here (bounded by
  # MAX_RESUMES) instead of reaching verify/leaderboards as an incomplete
  # bundle that quietly looks done.
  if [[ "$UNPLAYED" == "0" && "$FAILED" == "0" ]]; then
    break
  fi
  if [[ "$STOPPED" == "budget" && "$ATTEMPT_CALLS" == "0" ]]; then
    echo "pilot: the bundle-wide cap leaves no headroom — $UNPLAYED episodes unplayed and the ledger total (\$$LEDGER_TOTAL of \$$LEDGER_CAP) is within one call's worst case of the cap, so a resume can afford no call. Raise the cap." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [[ "$attempt" -gt "$MAX_RESUMES" ]]; then
    echo "pilot: giving up after $MAX_RESUMES invocations with $UNPLAYED unplayed and $FAILED failed episodes (raise PILOT_MAX_RESUMES or the cap)" >&2
    exit 1
  fi
  echo "pilot: cap bound — resuming ($((MAX_RESUMES - attempt + 1)) invocations left; the ledger total cannot pass \$$LEDGER_CAP)"
done

# 3. Verify: replay-verify every trajectory in the bundle.
echo "== [3/5] verify =="
node "$CLI" verify "$OUT/run" 2>&1 | tee "$OUT/verify.console.txt"

# 4. Leaderboard under all three scoring profiles. Decision #36 (the floor
# profile) is Sam's open call — publishing all three keeps that decision open.
# Profiles fail independently: one profile refusing must not lose the others.
echo "== [4/5] leaderboard (rhae-v1, chance-adjusted, squared-outcome) =="
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

# 5. Estimate vs actual: how the run's calls, tokens and dollars landed
# against the estimate's low and high figures. --no-probes keeps it
# engine-free like step 1.
echo "== [5/5] estimate --against =="
node "$CLI" estimate --suite "$SUITE" --agent "model:$MODEL" --prices "$PRICES" \
  --no-probes --against "$OUT/run" 2>&1 | tee "$OUT/estimate-against.console.txt"

# The --against table sums usage from trajectories only. A bundle-wide cap
# stop unwinds in-flight episodes: their PAID calls live in the ledger
# (ledger.unwoundUsd) but in no trajectory, so the table above can
# under-count actual spend whenever a cap stop discarded work. Reconcile
# loudly here; teaching estimate --against the ledger itself belongs to
# gauntlet/runs/ (outside this packet's paths).
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/run/run.json", "utf8"));
  const l = r.ledger ?? {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const unwound = num(l.unwoundUsd);
  console.log(`pilot: ledger reconciliation — trajectory usage is what estimate --against compares; the bundle ledger records \$${num(l.totalUsd).toFixed(6)} total (kept \$${num(l.keptUsd).toFixed(6)}, unwound \$${unwound.toFixed(6)} across ${l.unwoundCalls ?? 0} in-flight call(s))`);
  if (unwound > 0) {
    console.log(`pilot: WARNING — \$${unwound.toFixed(6)} of paid work was unwound at a cap stop and appears in NO trajectory, so the estimate-vs-actual table under-counts actual spend by that amount; cost the run against the ledger total \$${num(l.totalUsd).toFixed(6)}, not the table.`);
  }
' "$OUT"

echo "pilot: COMPLETE — model=$MODEL effort=$EFFORT cap=\$$CAP_USD bundle-wide ledgerTotalUsd=$LEDGER_TOTAL bundleSpendUsd=$BUNDLE_SPEND outputs in $OUT${LEADERBOARD_FAILED:+ (leaderboard failures:$LEADERBOARD_FAILED)}"
