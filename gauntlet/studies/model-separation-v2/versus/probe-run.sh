#!/bin/bash
# Probe run: serve one model, run the 1-seed probe suite, verify the bundle.
# Usage: probe-run.sh <model-file> <agent-stem> <tag>
set -euo pipefail
M="$1"; STEM="$2"; TAG="$3"
LLAMA=/home/user/work/llamacpp/llama-b11662/llama-server
MODELS=/home/user/work/gauntlet-models
HERE="$(cd "$(dirname "$0")" && pwd)"
GAUNT="$(cd "$HERE/../../.." && pwd)"
OUT="/tmp/probe-$TAG"

pkill -x llama-server 2>/dev/null || true
sleep 1
"$LLAMA" -m "$MODELS/$M" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-$TAG.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

until curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; do sleep 2; done
# /health returns 200 while the model still loads; a real completion is the
# readiness signal (S3: fetch-failed retries hitting a loading server).
for i in $(seq 1 120); do
  if curl -sf http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
       -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null 2>&1; then
    break
  fi
  sleep 2
done
echo "server-ready $TAG"

cd "$GAUNT"
START=$(date +%s)
node cli/gauntlet.js run --suite "$HERE/suite.probe.json" \
  --agent "model:openai-chat/$STEM" --base-url http://127.0.0.1:8080 \
  --out "$OUT" --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000
END=$(date +%s)
node cli/gauntlet.js bundle verify "$OUT"
echo "PROBE-COMPLETE $TAG wall=$((END-START))s"
