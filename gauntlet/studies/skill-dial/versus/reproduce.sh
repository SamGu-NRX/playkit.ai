#!/usr/bin/env bash
#
# End-to-end reproduction of the skill-dial-versus-engine study from a clean
# checkout of this branch. Deterministic: every agent is seeded and the
# scorer's bootstrap is keyed by suite id + agent id, so the regenerated
# results.json must be byte-identical to the committed one (checked with cmp).
#
# Usage, from gauntlet/:
#
#   bash studies/skill-dial/versus/reproduce.sh
#
# Requires: node, the calibration tables, and no running sibling jobs (the
# parallel stats wave saturates the sandbox's cores for a few minutes).

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GROOT="$(cd "$HERE/../.." && pwd)"
cd "$GROOT"

echo "== 1/4 installing dependencies =="
npm ci --silent

echo "== 2/4 running all study episodes (138 cells, parallel) =="
node studies/skill-dial/versus/run-study.mjs --concurrency=7

echo "== 3/4 regenerating the study-local scoring baseline and statistics =="
node scoring/generate-baseline.js \
  --tables=calibration/tables \
  --out=studies/skill-dial/versus/baseline-random.json
mkdir -p /tmp/dialstats-repro
pids=()
for g in tictactoe connect4 holdem chess chess-endgames chess-puzzles; do
  node studies/skill-dial/versus/compute-stats.mjs \
    --game="$g" \
    --runs=studies/skill-dial/versus/runs \
    --out="/tmp/dialstats-repro/$g.json" &
  pids+=($!)
done
wait "${pids[@]}"
node studies/skill-dial/versus/compute-stats.mjs \
  --runs=studies/skill-dial/versus/runs \
  --merge=/tmp/dialstats-repro/tictactoe.json,/tmp/dialstats-repro/connect4.json,/tmp/dialstats-repro/holdem.json,/tmp/dialstats-repro/chess.json,/tmp/dialstats-repro/chess-endgames.json,/tmp/dialstats-repro/chess-puzzles.json \
  --out=/tmp/dialstats-repro/results.json

echo "== 4/4 comparing against the committed results.json =="
cmp studies/skill-dial/versus/results.json /tmp/dialstats-repro/results.json
echo "REPRODUCTION OK: results.json is byte-identical."
