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

# Per-request limits: a hung server must reach the probe-exhaustion check
# instead of hanging this loop forever (greptile #115).
until curl -sf --connect-timeout 5 --max-time 30 http://127.0.0.1:8080/health >/dev/null 2>&1; do sleep 2; done
# /health returns 200 while the model still loads; a real completion is the
# readiness signal (S3: fetch-failed retries hitting a loading server).
READY=0
for i in $(seq 1 120); do
  if curl -sf --connect-timeout 5 --max-time 30 http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
       -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != 1 ]; then
  echo "server $TAG never answered a completion (probe exhausted)" >&2
  exit 1
fi
echo "server-ready $TAG"

cd "$GAUNT"
START=$(date +%s)
node cli/gauntlet.js run --suite "$HERE/suite.probe.json" \
  --agent "model:openai-chat/$STEM" --base-url http://127.0.0.1:8080 \
  --out "$OUT" --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000
END=$(date +%s)
node cli/gauntlet.js bundle verify "$OUT"
echo "PROBE-COMPLETE $TAG wall=$((END-START))s"
