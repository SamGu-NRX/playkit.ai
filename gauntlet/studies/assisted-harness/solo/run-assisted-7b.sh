#!/bin/bash
# 7B assisted ladder: fixed 4 public seeds on the same two tiers as the
# small-model arm (mastermind/mini, minesweeper/beginner) so the assisted
# arm is directly comparable cell by cell across sizes. Serves the model once.
# The assisted wrapper may spend up to 3 calls per turn (retries=2), so wall
# time per episode can be up to ~3x the unassisted arm; budget accordingly.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDIR="$(cd "$HERE/../../.." && pwd)"
RUNS="$HERE/runs/qwen2.5-7b-instruct-q4_k_m"
LLAMA=${LLAMA:-/home/user/burst7-model-store/llama-b11662/llama-server}
MODELS=${MODELS:-/home/user/work/gauntlet-models}
M=qwen2.5-7b-instruct-q4_k_m

pkill -f "llama-server" 2>/dev/null || true
sleep 1
"$LLAMA" -m "$MODELS/$M-00001-of-00002.gguf" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 2 > "/tmp/llama-assisted-$M.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
until curl -sf http://127.0.0.1:8080/health >/dev/null; do sleep 2; done
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up

cd "$GDIR"
run_one () {  # run_one <game>/<tier> <seeds>
  local TIER="$1" N="$2" SLUG SUITE OUT T0 T1
  SLUG="$(echo "$TIER" | tr '/' '-')"
  SUITE="/tmp/assisted-suites/$M-$SLUG-$N.json"
  node "$HERE/make-suite.mjs" "${TIER%%/*}" "${TIER##*/}" "$N" \
    --id "gauntlet-public-assisted-v1-$M-$SLUG-$N" > "$SUITE"
  OUT="$RUNS/$SLUG"
  mkdir -p "$OUT"
  echo "=== run $M $TIER seeds=$N"
  T0=$(date +%s)
  node cli/gauntlet.js run --suite "$SUITE" --agent "community-assisted:openai-chat/$M" \
    --base-url http://127.0.0.1:8080 --out "$OUT" \
    --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000 --max-calls 2500
  T1=$(date +%s)
  echo "=== done $M $TIER in $((T1 - T0))s"
  node cli/gauntlet.js bundle verify "$OUT"
  echo "$TIER $N $((T1 - T0))" >> /tmp/assisted-7b-timings.txt
}

mkdir -p /tmp/assisted-suites "$RUNS"; : > /tmp/assisted-7b-timings.txt
for TIER in mastermind/mini minesweeper/beginner; do
  run_one "$TIER" 4
done
echo "SEVEN-B-COMPLETE"
