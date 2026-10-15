#!/usr/bin/env bash
# Baseline runs for the first-model-run report.
# Runs after the model run finishes; sequential to keep CPU for the solvers.
# Outputs land as sibling run-random/, run-greedy-<game>/, run-engine-<game>/ dirs.
set -u
cd "$(dirname "$0")/../../.."   # -> gauntlet/
SUITE=reports/first-model-run/suite.public.first1.json
OUT=reports/first-model-run

echo "=== random (all 42 episodes) ==="
node cli/gauntlet.js run --suite "$SUITE" --agent baseline:random --out "$OUT/run-random" || echo "RANDOM FAILED exit=$?"

for g in mastermind connect4 sokoban chess sliding minesweeper holdem 2048; do
  echo "=== greedy $g ==="
  node cli/gauntlet.js run --suite "$SUITE" --agent "baseline:$g:greedy" --out "$OUT/run-greedy-$g" || echo "GREEDY $g FAILED exit=$?"
done

for g in mastermind connect4 sokoban chess sliding minesweeper holdem 2048; do
  echo "=== engine $g ==="
  node cli/gauntlet.js run --suite "$SUITE" --agent "baseline:$g:engine" --out "$OUT/run-engine-$g" || echo "ENGINE $g FAILED exit=$?"
done

echo "ALL BASELINES DONE"
