#!/usr/bin/env bash
#
# gauntlet/journeys/model/journey.sh — repeat the local-model suite run.
#
# Points Gauntlet at a running OpenAI-compatible server (llama.cpp llama-server
# was the path actually exercised), builds the 7-game public suite at 4 seeds
# per tier, estimates before, runs with bounds, bundle-verifies, reports
# estimate-vs-actual, and writes a leaderboard per scoring profile.
#
# Usage:
#   bash gauntlet/journeys/model/journey.sh [SERVER_URL]
#
# Environment overrides (defaults shown):
#   SERVER_URL=http://127.0.0.1:8081   OpenAI-compatible base URL (no /v1)
#   MODEL=qwen2.5-1.5b-instruct-q4_k_m Model label sent to the server
#   GAMES=tictactoe,connect4,chess,chess-endgames,chess-stockfish,minesweeper,mastermind
#   SEEDS_PER_TIER=4
#   CONCURRENCY=2
#   MAX_USD=1                          Nominal-dollar cap (see prices.nominal.json)
#   MAX_OUTPUT_TOKENS=256
#   CALL_TIMEOUT_MS=60000
#   RUNS_ROOT=./gauntlet-journey-runs  Where run bundles are written (not committed)
#
# The prices file prices the two Qwen2.5 models at a nominal rate so the
# --max-usd cap is exercised end to end (the server itself is free). For any
# other model, add a matching "openai-chat/<model>" entry to a copy of
# prices.nominal.json and pass it via PRICES.
#
# Runs from anywhere; the gauntlet package is found relative to this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAUNTLET_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
GAUNTLET="$GAUNTLET_DIR/cli/gauntlet.js"

SERVER_URL="${1:-${SERVER_URL:-http://127.0.0.1:8081}}"
MODEL="${MODEL:-qwen2.5-1.5b-instruct-q4_k_m}"
GAMES="${GAMES:-tictactoe,connect4,chess,chess-endgames,chess-stockfish,minesweeper,mastermind}"
SEEDS_PER_TIER="${SEEDS_PER_TIER:-4}"
CONCURRENCY="${CONCURRENCY:-2}"
MAX_USD="${MAX_USD:-1}"
MAX_OUTPUT_TOKENS="${MAX_OUTPUT_TOKENS:-256}"
CALL_TIMEOUT_MS="${CALL_TIMEOUT_MS:-60000}"
PRICES="${PRICES:-$SCRIPT_DIR/prices.nominal.json}"
RUNS_ROOT="${RUNS_ROOT:-$PWD/gauntlet-journey-runs}"
AGENT="model:openai-chat/$MODEL"

mkdir -p "$RUNS_ROOT"
SUITE="$RUNS_ROOT/suite.model$SEEDS_PER_TIER.json"

echo "== 0/6 server check: $SERVER_URL"
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -fsS --max-time 5 "$SERVER_URL/health" || true)"
  if [ -z "$HEALTH" ]; then
    echo "error: no /health answer from $SERVER_URL — is the model server up?" >&2
    echo "  llama.cpp: llama-server -m <model>.gguf --host 127.0.0.1 --port <port> --temp 0 --seed 42" >&2
    exit 1
  fi
  echo "   health: $HEALTH"
fi

if ! grep -q "\"openai-chat/$MODEL\"" "$PRICES"; then
  echo "warning: $PRICES has no \"openai-chat/$MODEL\" entry — a --max-usd run will refuse (unknown cost)." >&2
  echo "         copy the file, add your model, re-run with PRICES=<file>." >&2
fi

echo "== 1/6 suite build: $GAMES at $SEEDS_PER_TIER seed(s)/tier"
if [ ! -f "$SUITE" ]; then
  node "$GAUNTLET" suite build --split public --games "$GAMES" \
    --seeds-per-tier "$SEEDS_PER_TIER" --out "$SUITE"
fi

echo "== 2/6 estimate (before spending)"
node "$GAUNTLET" estimate --suite "$SUITE" --agent "$AGENT" --prices "$PRICES" \
  --out "$RUNS_ROOT/estimate-before"

echo "== 3/6 run with bounds: concurrency $CONCURRENCY, max-usd $MAX_USD, max-output-tokens $MAX_OUTPUT_TOKENS, call-timeout-ms $CALL_TIMEOUT_MS"
RUN_DIR="$RUNS_ROOT/run-$MODEL"
STOP_OK=0
node "$GAUNTLET" run --suite "$SUITE" --agent "$AGENT" \
  --base-url "$SERVER_URL" --prices "$PRICES" \
  --concurrency "$CONCURRENCY" --max-usd "$MAX_USD" \
  --max-output-tokens "$MAX_OUTPUT_TOKENS" --call-timeout-ms "$CALL_TIMEOUT_MS" \
  --out "$RUN_DIR" || STOP_OK=$?
if [ "$STOP_OK" -ne 0 ]; then
  echo "   run stopped early (exit $STOP_OK) — re-run this script with the same RUNS_ROOT; it resumes."
fi

echo "== 4/6 bundle verify"
node "$GAUNTLET" bundle verify "$RUN_DIR"

echo "== 5/6 estimate vs actual"
node "$SCRIPT_DIR/estimate-check.mjs" "$RUN_DIR" "$RUNS_ROOT/estimate-before" || true

echo "== 6/6 leaderboard under each scoring profile"
for PROFILE in rhae-v1 chance-adjusted squared-outcome; do
  node "$GAUNTLET" leaderboard --suite "$SUITE" --scoring-profile "$PROFILE" \
    --out "$RUNS_ROOT/leaderboard-$PROFILE" "$RUN_DIR"
done

echo "== done — bundles under $RUNS_ROOT"
