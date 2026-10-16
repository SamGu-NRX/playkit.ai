#!/bin/bash
# One model run of the model-separation suite against a local llama.cpp server.
# Identical serving settings to PR #43: llama-server b11662, ctx 4096, temp 0,
# seed 42, threads 8, one warm-up call, concurrency 1 (CLI default), max-calls
# 2500. Usage:
#   run-model.sh <gauntlet-dir> <out-dir> <model-file-stem> <suite-rel-path> <tag>
set -euo pipefail
GDIR="$1"; OUT="$2"; M="$3"; SUITE="$4"; TAG="$5"
LLAMA=/home/user/work/llamacpp/llama-b11662/llama-server
MODELS=/home/user/work/gauntlet-models

pkill -f llama-server 2>/dev/null || true
sleep 1
"$LLAMA" -m "$MODELS/$M.gguf" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-$TAG.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
until curl -sf http://127.0.0.1:8080/health >/dev/null; do sleep 2; done
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up

cd "$GDIR"
node cli/gauntlet.js run --suite "$SUITE" --agent "model:openai-chat/$M" \
  --base-url http://127.0.0.1:8080 --out "$OUT" --max-calls 2500
node cli/gauntlet.js bundle verify "$OUT"
echo "RUN-COMPLETE $OUT"
