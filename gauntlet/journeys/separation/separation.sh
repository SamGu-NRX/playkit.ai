#!/usr/bin/env bash
# separation.sh — replay the researcher's separation journey from a clean clone,
# exiting non-zero on the first failure.
#
# Stages, in order:
#   B  estimate the public suite with probe episodes (Go + Stockfish engines
#      installed): assert it exits on its own within a bound and leaves no
#      engine process behind.
#   C  a capped bundle run against the pilot's loopback Anthropic stub with
#      --max-usd-total low enough to bind, resumed until it finishes or has
#      nothing left it may play: quote the ledger (total, kept, unwound) and
#      assert the settled total never passed the cap.
#   D  one model episode against a stalled stub reply with
#      --episode-time-limit-ms: the episode ends time-limit, the trajectory
#      replay-verifies, and the stub sees the connection close.
#   E  the separation pilot's preregistered instrument checks
#      (studies/separation-pilot/instrument.sh): two dial stand-ins of known
#      different strength must SEPARATE, two identical ones must not, the
#      label swap must negate D exactly.
#
# Everything is free: stub agents never leave the loopback, engine probes and
# dial arms are bundled baselines, and no provider API key is needed or read.
#
# Usage:
#   journeys/separation/separation.sh [REPO_URL] [REF] [WORKDIR]
#
#   REPO_URL  default: the origin remote of the checkout this script lives in
#   REF       default: the HEAD commit of that checkout
#   WORKDIR   default: a fresh temporary directory (kept on failure)
#
# Environment:
#   SEPARATION_MAX_USD_TOTAL   stage C's bundle cap (default 0.5)
#   SEPARATION_ESTIMATE_SECS   stage B's bound on the estimate (default 900)
#   SEPARATION_INSTRUMENT_SECS stage E's bound on instrument.sh (default 2400)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_default="$(git -C "$here/../.." remote get-url origin 2>/dev/null || true)"
ref_default="$(git -C "$here/../.." rev-parse HEAD 2>/dev/null || echo alpha)"

REPO_URL="${1:-${repo_default:-https://github.com/SamGu-NRX/playkit.ai.git}}"
REF="${2:-$ref_default}"
WORK="${3:-$(mktemp -d /tmp/separation-journey.XXXXXX)}"

CAP="${SEPARATION_MAX_USD_TOTAL:-2}"
ESTIMATE_SECS="${SEPARATION_ESTIMATE_SECS:-900}"
INSTRUMENT_SECS="${SEPARATION_INSTRUMENT_SECS:-2400}"
MODEL="anthropic/claude-opus-5-5"

mkdir -p "$WORK/logs"
LOG="$WORK/logs"

die() { echo "separation: FAIL $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

step "clean clone: $REPO_URL @ $REF into $WORK/src"
git clone --quiet "$REPO_URL" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$REF"
SRC="$WORK/src/gauntlet"
PRICES="$SRC/reports/release/prices.frontier.json"
[ -f "$PRICES" ] || die "prices file not found at $PRICES"

step "npm ci"
(cd "$SRC" && npm ci --no-audit --no-fund >"$LOG/npm-ci.log" 2>&1) || die "npm ci failed (see $LOG/npm-ci.log)"

#
# Stage B — estimate the public suite, with engines installed.
#
step "B: estimate on the public suite (probes on; GNU Go + Stockfish installed)"
node "$SRC/cli/gauntlet.js" suite build --split public --seeds-per-tier 1 \
  --out "$WORK/suite-public.json" >"$LOG/suite-build.log" 2>&1 \
  || die "B: suite build failed (see $LOG/suite-build.log)"

b_rc=0
t0=$(date +%s)
timeout "$ESTIMATE_SECS" node "$SRC/cli/gauntlet.js" estimate \
  --suite "$WORK/suite-public.json" --agent "model:$MODEL" --prices "$PRICES" \
  --out "$WORK/estimate" >"$LOG/estimate.log" 2>&1 || b_rc=$?
b_elapsed=$(( $(date +%s) - t0 ))

if [ "$b_rc" -ne 0 ]; then
  tail -20 "$LOG/estimate.log" >&2 || true
  die "B: estimate exited $b_rc (did not exit on its own; see $LOG/estimate.log)"
fi
if [ "$b_elapsed" -ge "$ESTIMATE_SECS" ]; then
  die "B: estimate took ${b_elapsed}s, at the ${ESTIMATE_SECS}s bound"
fi
sleep 1
if pgrep -x gnugo >/dev/null 2>&1 || pgrep -x stockfish >/dev/null 2>&1; then
  pgrep -a -x gnugo || true; pgrep -a -x stockfish || true
  die "B: an engine process is still running after estimate exited"
fi
echo "B: PASS — estimate exited on its own in ${b_elapsed}s; no gnugo/stockfish process left"

#
# Stage C — a capped bundle run against the pilot's Anthropic stub.
#
step "C: capped run (--max-usd-total $CAP) against the pilot stub"
node "$SRC/journeys/pilot/stubs/anthropic.mjs" --port 8091 \
  --rate-limit-every 5 --overload-every 13 --refuse-every 11 --truncate-every 7 \
  >"$LOG/stub-c.log" 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  node -e "fetch('http://127.0.0.1:8091/v1/ping',{method:'POST',body:'{}'}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 0.2
done
kill -0 "$STUB_PID" 2>/dev/null || die "C: stub failed to start (see $LOG/stub-c.log)"

ledger() {
  node -e '
    import(process.argv[1]).then(async (m) => {
      const l = await m.readSpendLedger(process.argv[2]);
      console.log(JSON.stringify(l.summary ?? {}));
    })' "$SRC/runs/run.js" "$WORK/bundle-cap"
}

RUN=(node "$SRC/cli/gauntlet.js" run --suite "$WORK/suite-public.json"
     --agent "model:$MODEL" --out "$WORK/bundle-cap" --max-usd-total "$CAP"
     --base-url http://127.0.0.1:8091 --prices "$PRICES")

# Completion is read from run.json, not grepped from the console: cli/run.js
# prints "stopped <reason>" only when there IS a stop reason, while a
# finished run prints "done     every planned episode has a trajectory" with
# no stopped prefix — grepping for "stopped done" can never match success.
verdict_of() {
  node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/run.json", "utf8"));
    const done = (r.stopped ?? null) === null && r.counts.unplayed === 0 && r.counts.failed === 0;
    console.log(done ? "done" : (r.stopped ?? "failed"));
  ' "$WORK/bundle-cap"
}

c_out="$LOG/run-attempt-1.log"
# The stub accepts any key, but the model agent resolves ANTHROPIC_API_KEY
# at call time and throws when it is unset (harness/model-agent.js
# resolveApiKey) — without a key the first act fails before any request and
# attempt 1 can never stop on the cap. Stage D already does this; keep the
# journey self-contained (no ambient credentials).
timeout 900 env ANTHROPIC_API_KEY=dummy-rehearsal-key "${RUN[@]}" >"$c_out" 2>&1 || true
grep -qE "stopped[ =]+budget" "$c_out" || die "C: attempt 1 did not stop on the budget cap (see $c_out)"
echo "C: attempt 1 bound the cap: $(grep -oE 'stopped[ =]+budget.*' "$c_out" | head -1)"
prev_total="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.totalUsd ?? 0)' "$(ledger)")"
echo "C: ledger after attempt 1: total $prev_total"
verdict=""; attempt=1
while [ "$attempt" -lt 6 ]; do
  attempt=$((attempt + 1))
  c_out="$LOG/run-attempt-$attempt.log"
  timeout 900 env ANTHROPIC_API_KEY=dummy-rehearsal-key "${RUN[@]}" --resume >"$c_out" 2>&1 || true
  summary="$(ledger)"
  total="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.totalUsd ?? "null")' "$summary")"
  if [ "$(verdict_of)" = "done" ]; then verdict="finished on attempt $attempt (every planned episode has a trajectory)"; break; fi
  if grep -qE "stopped[ =]+budget" "$c_out"; then
    if node -e "process.exit(Math.abs(Number(process.argv[1]) - Number(process.argv[2])) < 1e-9 ? 0 : 1)" "$total" "$prev_total"; then
      verdict="refused on attempt $attempt (stopped=budget, 0 episodes played — the cap is exhausted with work remaining)"
      break
    fi
    echo "C: attempt $attempt resume made progress: total $prev_total -> $total"
    prev_total="$total"
  else
    die "C: attempt $attempt ended neither done nor budget (see $c_out)"
  fi
done
[ -n "$verdict" ] || die "C: still binding the cap after 5 resumes (see $LOG)"

summary="$(ledger)"
echo "C: ledger summary: $summary"
echo "C: $verdict"
node -e '
  const s = JSON.parse(process.argv[1]); const cap = Number(process.argv[2]);
  if (!(s.totalUsd <= cap + 1e-9)) {
    console.error(`C: FAIL — ledger total ${s.totalUsd} passed the cap ${cap}`);
    process.exit(1);
  }
  console.log(`C: PASS — settled total ${s.totalUsd} never passed the cap ${cap} (kept ${s.keptUsd}, unwound ${s.unwoundUsd} across ${s.unwoundCalls} unwound episode call(s), ${s.calls} calls)`);
' "$summary" "$CAP" || die "C: cap assertion failed"
case "$verdict" in
  finished*)
    node "$SRC/cli/gauntlet.js" verify "$WORK/bundle-cap" >"$LOG/verify-c.log" 2>&1 \
      || die "C: bundle verify failed after done (see $LOG/verify-c.log)"
    echo "C: bundle replay-verified after completion"
    ;;
esac

kill "$STUB_PID" 2>/dev/null || true
wait "$STUB_PID" 2>/dev/null || true
trap - EXIT

#
# Stage D — an episode against a stalled stub reply, under --episode-time-limit-ms.
#
step "D: episode time limit against a stalled reply"
node "$SRC/journeys/separation/stalled-stub.mjs" --port 8092 --log "$LOG/stub-d.log" >"$LOG/stub-d-stdout.log" 2>&1 &
STALL_PID=$!
trap 'kill "$STALL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  node -e "fetch('http://127.0.0.1:8092/ping').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 0.2
done
kill -0 "$STALL_PID" 2>/dev/null || die "D: stalled stub failed to start (see $LOG/stub-d-stdout.log)"

mkdir -p "$WORK/time-limit"
d_rc=0
t0=$(date +%s)
timeout 120 env ANTHROPIC_API_KEY=dummy-rehearsal-key \
  node "$SRC/cli/gauntlet.js" play --game mastermind --tier mini --split public \
  --agent "model:$MODEL" --base-url http://127.0.0.1:8092 \
  --episode-time-limit-ms 8000 --prices "$PRICES" \
  --out "$WORK/time-limit/trajectory.json" >"$LOG/play-time-limit.log" 2>&1 || d_rc=$?
d_elapsed=$(( $(date +%s) - t0 ))

grep -q "time-limit" "$LOG/play-time-limit.log" \
  || { tail -20 "$LOG/play-time-limit.log" >&2 || true; die "D: play output does not end time-limit (rc $d_rc)"; }
if [ "$d_elapsed" -ge 60 ]; then
  die "D: play took ${d_elapsed}s — the time limit did not end the episode promptly"
fi
grep -q "connection closed by the client" "$LOG/stub-d.log" \
  || die "D: the stub never saw the connection close (see $LOG/stub-d.log)"
node "$SRC/cli/gauntlet.js" verify "$WORK/time-limit/trajectory.json" >"$LOG/verify-d.log" 2>&1 \
  || die "D: the time-limited episode's trajectory did not replay-verify (see $LOG/verify-d.log)"
echo "D: PASS — episode ended time-limit in ${d_elapsed}s, trajectory verified, stub saw the connection close"

kill "$STALL_PID" 2>/dev/null || true
wait "$STALL_PID" 2>/dev/null || true
trap - EXIT

#
# Stage E — the separation pilot's preregistered instrument checks.
#
step "E0: re-cut suite.smallest-8.json at current game versions (make-suite.mjs)"
# Journey E depends on a version chain: tier audit (studies/tier-audit/
# tiers.json, PR #107) -> committed suite -> instrument arms. #108 shipped
# wordle 1.2.0 after #109's instrument ran, so the chain is stale at this
# head: make-suite.mjs's own guard refuses until the audit is re-run
# ('update the audit first'), and plan.js refuses the committed 1.1.0 pin.
# That repair is the study owner's (outside this journey's paths), so when
# the re-cut refuses this script reports PARTIAL instead of pretending green,
# and still runs the instrument so the arms whose pins still match play green
# on the record.
E_BLOCKED=""
if ! (cd "$SRC/studies/separation-pilot" && node make-suite.mjs --option smallest \
   --out outputs/suites/suite.smallest-8.json) >"$LOG/make-suite.log" 2>&1; then
  E_BLOCKED="the tier audit (studies/tier-audit/tiers.json, PR #107) recorded wordle 1.1.0 but the registry is at 1.2.0 after #108; make-suite.mjs refuses (update the audit first) and plan.js refuses the committed 1.1.0 pin"
  echo "E: BLOCKED — $E_BLOCKED"
  echo "E: running the instrument anyway; arms whose pins still match will play, the wordle arm will refuse (evidence for the PR)"
fi

step "E: separation-pilot instrument checks (dial stand-ins through the real path)"
if ( cd "$SRC/studies/separation-pilot" && timeout "$INSTRUMENT_SECS" ./instrument.sh \
     >"$LOG/instrument.log" 2>&1 ) && grep -q "INSTRUMENT-CHECKS: PASS" "$LOG/instrument.log"; then
  grep "PASS I1\|PASS I2\|PASS label swap" "$LOG/instrument.log" || true
  echo "E: PASS — two dial stand-ins separate, two identical ones do not, label swap is exact"
else
  if [ -n "$E_BLOCKED" ]; then
    echo "E: instrument stopped on the stale pin as expected; arms that played are green in $LOG/instrument.log"
  else
    die "E: instrument.sh failed or did not print INSTRUMENT-CHECKS: PASS (see $LOG/instrument.log)"
  fi
fi

echo
if [ -n "$E_BLOCKED" ]; then
  echo "SEPARATION-JOURNEY: PARTIAL — B, C, D green; E blocked at $REF"
  echo "  blocked because: $E_BLOCKED"
  echo "  repair (study owner): re-run the tier audit at wordle 1.2.0, re-cut the suite, re-commit, re-run"
  echo "work dir kept at: $WORK"
  exit 1
fi
echo "SEPARATION-JOURNEY: PASS — B, C, D, E all green on $REF"
echo "work dir kept at: $WORK"
