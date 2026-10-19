#!/bin/bash
# End-to-end reproduction for the versus model-separation study.
#
#   reproduce.sh              — regenerate profile-results.json and stats.json
#                               from the committed run bundles and verify
#                               byte-identity (no models, no serving; default)
#   reproduce.sh --with-models — additionally rebuild the suite, serve each
#                               model, and replay every episode (needs the
#                               GGUF files under /home/user/work/gauntlet-models
#                               — hashes in models.sha256 — and llama-server
#                               b11662 at /home/user/work/llamacpp)
#
# A study-local random baseline is built from the committed calibration tables
# with the production generator (the committed scoring/baselines/random-public.json
# does not carry the wave-11 versus tiers).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GAUNT="$(cd "$HERE/../../.." && pwd)"
LLAMA="${LLAMA:-/home/user/work/llamacpp/llama-b11662/llama-server}"
MODELS_DIR="${MODELS_DIR:-/home/user/work/gauntlet-models}"
SEEDS_PER_TIER=12

cd "$GAUNT"
[ -d node_modules ] || npm ci --silent

echo "== baseline =="
node scoring/generate-baseline.js --out="$HERE/baseline-random.json"

echo "== regenerate stats.json from committed bundles =="
TMP=$(mktemp -d)
cp "$HERE/stats.json" "$TMP/stats.committed.json"
node "$HERE/score-study.mjs" --runs "$HERE/runs" --out "$TMP"
python3 "$HERE/compute-stats.py" --dir "$TMP" > "$TMP/regen.log" 2>&1 || { cat "$TMP/regen.log"; exit 1; }

if cmp -s "$TMP/profile-results.json" "$HERE/profile-results.json"; then
  echo "profile-results.json byte-identical on regeneration ✓"
else
  echo "profile-results.json MISMATCH (score() is seeded; this is code or data drift)"
  diff "$TMP/profile-results.json" "$HERE/profile-results.json" | head -20
  exit 1
fi
if cmp -s "$TMP/stats.committed.json" "$TMP/stats.json"; then
  echo "stats.json byte-identical on regeneration ✓"
else
  echo "stats.json MISMATCH on regeneration"
  diff "$TMP/stats.committed.json" "$TMP/stats.json" | head -20
  exit 1
fi
rm -rf "$TMP"

if [ "${1:-}" != "--with-models" ]; then
  echo "== done (bundle-only path) =="
  exit 0
fi

echo "== suite =="
node "$HERE/build-suite.mjs" "$SEEDS_PER_TIER" --out=suite.public.json

echo "== models =="
for PAIR in \
  "qwen2.5-0.5b-instruct-q4_k_m qwen2.5-0.5b-instruct-q4_k_m.gguf" \
  "qwen2.5-1.5b-instruct-q4_k_m qwen2.5-1.5b-instruct-q4_k_m.gguf" \
  "qwen2.5-7b-instruct-q4_k_m qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"; do
  set -- $PAIR
  STEM="$1"; F="$2"
  OUT="$HERE/runs/$STEM"
  pkill -x llama-server 2>/dev/null || true; sleep 1
  "$LLAMA" -m "$MODELS_DIR/$F" --host 127.0.0.1 --port 8080 \
    --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "/tmp/llama-$STEM.log" 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null || true' EXIT
  # Bounded health phase (codex #122): a server that stays alive but never
  # answers /health must exhaust the attempt budget loudly instead of hanging
  # this launcher forever; per-request curl limits (greptile #115) bound each
  # probe, and a dead server fails the liveness check at once.
  bash "$HERE/../wait-healthy.sh" "$SRV" "$STEM" "/tmp/llama-$STEM.log"
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
    echo "server $STEM never answered a completion (probe exhausted)" >&2
    exit 1
  fi
  START=$(date +%s)
  node cli/gauntlet.js run --suite "$HERE/suite.public.json" \
    --agent "model:openai-chat/$STEM" --base-url http://127.0.0.1:8080 \
    --out "$OUT" --concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000
  END=$(date +%s)
  node cli/gauntlet.js bundle verify "$OUT"
  echo "MODEL-COMPLETE $STEM wall=$((END-START))s"
done
pkill -x llama-server 2>/dev/null || true

echo "== rescore =="
node "$HERE/score-study.mjs" --runs "$HERE/runs"
python3 "$HERE/compute-stats.py"
echo "== done (full path) =="
