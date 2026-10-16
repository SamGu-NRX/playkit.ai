#!/bin/bash
# Full study runs: serve each model, run the 12-seed suite, verify each bundle.
# Order is 7B first (the long pole). Usage: full-run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GAUNT="$(cd "$HERE/../../.." && pwd)"
LLAMA=/home/user/work/llamacpp/llama-b11662/llama-server
MODELS_DIR=/home/user/work/gauntlet-models
SEEDS_PER_TIER=12

cd "$GAUNT"
node "$HERE/build-suite.mjs" "$SEEDS_PER_TIER" --out="$HERE/suite.public.json"

for PAIR in \
  "qwen2.5-7b-instruct-q4_k_m qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf" \
  "qwen2.5-1.5b-instruct-q4_k_m qwen2.5-1.5b-instruct-q4_k_m.gguf" \
  "qwen2.5-0.5b-instruct-q4_k_m qwen2.5-0.5b-instruct-q4_k_m.gguf"; do
  set -- $PAIR
  STEM="$1"; F="$2"
  OUT="$HERE/runs/$STEM"
  pkill -x llama-server 2>/dev/null || true; sleep 1
  "$LLAMA" -m "$MODELS_DIR/$F" --host 127.0.0.1 --port 8080 \
    --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-$STEM.log" 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null || true' EXIT
  until curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; do sleep 2; done
  for i in $(seq 1 120); do
    curl -sf http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
      -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null 2>&1 && break
    sleep 2
  done
  echo "server-ready $STEM $(date -u +%H:%M:%SZ)"
  START=$(date +%s)
  node cli/gauntlet.js run --suite "$HERE/suite.public.json" \
    --agent "model:openai-chat/$STEM" --base-url http://127.0.0.1:8080 \
    --out "$OUT" --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000
  END=$(date +%s)
  node cli/gauntlet.js bundle verify "$OUT"
  echo "MODEL-COMPLETE $STEM wall=$((END-START))s $(date -u +%H:%M:%SZ)"
done
pkill -x llama-server 2>/dev/null || true
echo "ALL-RUNS-COMPLETE $(date -u +%H:%M:%SZ)"
