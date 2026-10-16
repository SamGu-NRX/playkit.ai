#!/bin/bash
# Serve one local model (pinned method: llama.cpp b11662, ctx 4096, temp 0,
# seed 42, threads matched to this 2-core box, one warm-up call) and run a
# list of one-tier suites against it on the COMMUNITY track through the
# assisted wrapper (community-assisted:openai-chat/<stem>, default retries=2)
# with concurrency 1, a 256-token reply cap and a 60 s call timeout.
# Verifies every bundle it writes.
#
# Usage: serve-and-run-assisted.sh <model-file-stem> <specs-file> <runs-root>
#   specs-file lines (whitespace-separated):  <gameId>/<tierId> <seedCount>
set -euo pipefail

GDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA=${LLAMA:-/home/user/burst7-model-store/llama-b11662/llama-server}
MODELS=${MODELS:-/home/user/work/gauntlet-models}
M="$1"; SPECS="$2"; ROOT="$3"

pkill -f llama-server 2>/dev/null || true
sleep 1
"$LLAMA" -m "$MODELS/$M.gguf" --host 127.0.0.1 --port 8080 \
  --ctx-size 4096 --temp 0.0 --seed 42 --threads 2 > "/tmp/llama-assisted-$M.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
until curl -sf http://127.0.0.1:8080/health >/dev/null; do sleep 2; done
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up

mkdir -p "$ROOT" /tmp/assisted-suites
cd "$GDIR"
while read -r TIER N; do
  [ -z "$TIER" ] && continue
  SLUG="$(echo "$TIER" | tr '/' '-')"
  SUITE="/tmp/assisted-suites/$M-$SLUG-$N.json"
  node "$HERE/make-suite.mjs" "${TIER%%/*}" "${TIER##*/}" "$N" \
    --id "gauntlet-public-assisted-v1-$M-$SLUG-$N" > "$SUITE"
  OUT="$ROOT/$SLUG"
  mkdir -p "$OUT"
  echo "=== run $M $TIER seeds=$N -> $OUT"
  T0=$(date +%s)
  node cli/gauntlet.js run --suite "$SUITE" --agent "community-assisted:openai-chat/$M" \
    --base-url http://127.0.0.1:8080 --out "$OUT" \
    --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000 --max-calls 2500
  T1=$(date +%s)
  echo "=== done $M $TIER in $((T1 - T0))s"
  node cli/gauntlet.js bundle verify "$OUT"
done < "$SPECS"
echo "ALL-RUNS-COMPLETE $M"
