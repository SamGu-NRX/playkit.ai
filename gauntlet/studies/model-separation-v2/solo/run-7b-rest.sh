#!/bin/bash
# Remaining 7B tiers at 4 seeds each, cheap-first, within a hard deadline.
# Skips tiers whose measured-episode budget does not fit. Serves nothing:
# expects the llama-server from run-7b.sh to still be alive on :8080.
#   usage: run-7b-rest.sh <deadline-epoch-seconds>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDIR="$(cd "$HERE/../../.." && pwd)"
RUNS="$HERE/runs/qwen2.5-7b-instruct-q4_k_m"
DEADLINE=${1:?deadline epoch seconds}
M=qwen2.5-7b-instruct-q4_k_m
LLAMA=${LLAMA:-/home/user/work/llamacpp/llama-b11662/llama-server}
MODELS=${MODELS:-/home/user/work/gauntlet-models}
if ! curl -sf http://127.0.0.1:8080/health >/dev/null; then
  echo "no server on :8080; starting one"
  pkill -f llama-server 2>/dev/null; sleep 1
  "$LLAMA" -m "$MODELS/$M-00001-of-00002.gguf" --host 127.0.0.1 --port 8080 \
    --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > /tmp/llama-msep-v2-7b-rest.log 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null || true' EXIT
  # Bounded health phase (codex #122): a server that stays alive but never
  # answers /health must exhaust the attempt budget loudly instead of hanging
  # this launcher forever; per-request curl limits (greptile #115) bound each
  # probe, and a dead server fails the liveness check at once.
  if ! bash "$HERE/../wait-healthy.sh" "$SRV" "7b-rest" "/tmp/llama-msep-v2-7b-rest.log"; then
    echo "server 7b-rest never became healthy; aborting before the tier runs" >&2
    exit 1
  fi
  curl -s --connect-timeout 5 --max-time 30 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null
fi

cd "$GDIR"
for TIER in cube/cube-2 minesweeper/beginner mastermind/mini sliding/p8-short sokoban/one-box nonogram/tiny; do
  NOW=$(date +%s); LEFT=$((DEADLINE - NOW))
  [ $LEFT -lt 240 ] && { echo "=== DROP 7B $TIER (${LEFT}s left < 240s)"; continue; }
  SLUG="$(echo "$TIER" | tr '/' '-')"
  SUITE="/tmp/msep-v2-suites/$M-$SLUG-4.json"
  node "$HERE/make-suite.mjs" "${TIER%%/*}" "${TIER##*/}" 4 \
    --id "gauntlet-public-msep-v2-$M-$SLUG-4" > "$SUITE" || continue
  OUT="$RUNS/$SLUG"
  mkdir -p "$OUT"
  echo "=== run $M $TIER seeds=4 (${LEFT}s left)"
  node cli/gauntlet.js run --suite "$SUITE" --agent "model:openai-chat/$M" \
    --base-url http://127.0.0.1:8080 --out "$OUT" \
    --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000 --max-calls 2500
  node cli/gauntlet.js bundle verify "$OUT"
done
echo "SEVEN-B-REST-COMPLETE"
