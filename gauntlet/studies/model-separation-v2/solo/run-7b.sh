#!/bin/bash
# 7B ladder: cheap tiers first, one measurement episode per tier, then as many
# seeds per tier as the remaining wall-clock budget allows (8 preferred, 4
# minimum, drop with a note otherwise). Serves the model once.
#   usage: run-7b.sh <deadline-epoch-seconds>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDIR="$(cd "$HERE/../../.." && pwd)"
RUNS="$HERE/runs/qwen2.5-7b-instruct-q4_k_m"
DEADLINE=${1:?deadline epoch seconds}
LLAMA=${LLAMA:-/home/user/work/llamacpp/llama-b11662/llama-server}
MODELS=${MODELS:-/home/user/work/gauntlet-models}
M=qwen2.5-7b-instruct-q4_k_m

pkill -f "llama-server" 2>/dev/null || true
sleep 1
"$LLAMA" -m "$MODELS/$M-00001-of-00002.gguf" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-msep-v2-$M.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
# Bounded health phase (codex #122): a server that stays alive but never
# answers /health must exhaust the attempt budget loudly instead of hanging
# this launcher forever; per-request curl limits (greptile #115) bound each
# probe, and a dead server fails the liveness check at once.
bash "$HERE/../wait-healthy.sh" "$SRV" "$M" "/tmp/llama-msep-v2-$M.log"
curl -s --connect-timeout 5 --max-time 30 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up

cd "$GDIR"
run_one () {  # run_one <game>/<tier> <seeds> <out-root>
  local TIER="$1" N="$2" ROOT="$3" SLUG SUITE OUT T0 T1
  SLUG="$(echo "$TIER" | tr '/' '-')"
  SUITE="/tmp/msep-v2-suites/$M-$SLUG-$N.json"
  node "$HERE/make-suite.mjs" "${TIER%%/*}" "${TIER##*/}" "$N" \
    --id "gauntlet-public-msep-v2-$M-$SLUG-$N" > "$SUITE"
  OUT="$ROOT/$SLUG"
  mkdir -p "$OUT"
  echo "=== run $M $TIER seeds=$N"
  T0=$(date +%s)
  node cli/gauntlet.js run --suite "$SUITE" --agent "model:openai-chat/$M" \
    --base-url http://127.0.0.1:8080 --out "$OUT" \
    --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000 --max-calls 2500
  T1=$(date +%s)
  echo "=== done $M $TIER seeds=$N in $((T1 - T0))s"
  node cli/gauntlet.js bundle verify "$OUT"
  echo "$TIER $N $((T1 - T0))" >> /tmp/msep-v2-7b-timings.txt
}

mkdir -p /tmp/msep-v2-suites "$RUNS"; : > /tmp/msep-v2-7b-timings.txt
# measurement pass, cheap tiers first: one episode each
MEASURE=""
for TIER in cube/cube-2 mastermind/mini sliding/p8-short sokoban/one-box minesweeper/beginner nonogram/tiny; do
  if timeout 900 bash -c "$(declare -f run_one); run_one '$TIER' 1 /tmp/msep-v2-measure"; then MEASURE="$MEASURE $TIER"; else
    echo "=== measure $TIER exceeded 900s; dropping 7B from this tier"; fi
  NOW=$(date +%s)
  echo "=== remaining budget $((DEADLINE - NOW))s after measure $TIER"
  [ $((DEADLINE - NOW)) -lt 240 ] && { echo "=== budget exhausted in measurement"; break; }
done

# seeding pass: 8 seeds when the measured episode time allows, else 4, else drop
declare -A TA
while read -r TIER N SEC; do TA[$TIER]=$SEC; done < /tmp/msep-v2-7b-timings.txt
for TIER in cube/cube-2 mastermind/mini sliding/p8-short sokoban/one-box minesweeper/beginner nonogram/tiny; do
  [ -n "${TA[$TIER]:-}" ] || { echo "=== DROP 7B $TIER (measurement exceeded 900s)"; continue; }
  NOW=$(date +%s); LEFT=$((DEADLINE - NOW))
  T=${TA[$TIER]}
  if [ $((T * 8 + 60)) -le $LEFT ]; then N=8
  elif [ $((T * 4 + 60)) -le $LEFT ]; then N=4
  else echo "=== DROP 7B $TIER (measured ${T}s/episode, $LEFT s left)"; continue; fi
  run_one "$TIER" "$N" "$RUNS"
done
echo "SEVEN-B-COMPLETE"
