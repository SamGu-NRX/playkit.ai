#!/bin/bash
# Serve one local model (pinned method, identical to model-separation-v2's
# serve-and-run.sh: llama.cpp b11662, ctx 4096, temp 0, seed 42, threads 8,
# one warm-up call) and run example-confound arms against it with concurrency
# 1, a 256-token reply cap and a 60 s call timeout. Verifies every bundle.
#
# Usage: serve-and-run.sh <model-file-stem> <arms-file> <runs-root>
#   arms-file lines (whitespace-separated): <arm> <gameId>/<tierId> <seedCount>
# The suite for each arm is generated from the registered game definitions
# (run-arm.mjs, same publicSeed scheme as #81/#92) and the run output carries
# run.json + suite.json next to the bundles.
set -euo pipefail

GDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # the gauntlet package
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA=${LLAMA:-/home/user/work/llamacpp/llama-b11662/llama-server}
MODELS=${MODELS:-/home/user/work/gauntlet-models}
M="$1"; ARMS="$2"; ROOT="$3"

pkill -f llama-server 2>/dev/null || true
sleep 1
MODELFILE="$MODELS/$M.gguf"
[ -f "$MODELFILE" ] || MODELFILE="$MODELS/$M-00001-of-00002.gguf"   # sharded GGUF: llama.cpp auto-merges
"$LLAMA" -m "$MODELFILE" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-example-confound-$M.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
until curl -sf http://127.0.0.1:8080/health >/dev/null; do sleep 2; done
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up

mkdir -p "$ROOT"
cd "$GDIR"
while read -r ARM TIER N; do
  [ -z "$ARM" ] && continue
  SLUG="$(echo "$TIER" | tr '/' '-')-$ARM"
  OUT="$ROOT/$SLUG"
  mkdir -p "$OUT"
  echo "=== run $M $ARM $TIER seeds=$N -> $OUT"
  T0=$(date +%s)
  node "$HERE/run-arm.mjs" --arm "$ARM" --game "${TIER%%/*}" --tier "${TIER##*/}" \
    --seeds "$N" --model "$M" --out "$OUT" --resume
  T1=$(date +%s)
  echo "=== done $M $ARM $TIER in $((T1 - T0))s"
  node cli/gauntlet.js bundle verify "$OUT"
done < "$ARMS"
echo "ALL-RUNS-COMPLETE $M"
