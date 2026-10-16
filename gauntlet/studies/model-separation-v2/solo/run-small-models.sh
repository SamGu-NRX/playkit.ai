#!/bin/bash
# Run the 0.5B and 1.5B ladders back to back (server restarted per model).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$HERE/runs"
printf 'sliding/p8-short 8\nsokoban/one-box 8\nmastermind/mini 8\ncube/cube-2 8\nnonogram/tiny 8\nminesweeper/beginner 8\n' > /tmp/msep-v2-specs-small.txt
bash "$HERE/serve-and-run.sh" qwen2.5-0.5b-instruct-q4_k_m /tmp/msep-v2-specs-small.txt "$RUNS/qwen2.5-0.5b-instruct-q4_k_m"
bash "$HERE/serve-and-run.sh" qwen2.5-1.5b-instruct-q4_k_m /tmp/msep-v2-specs-small.txt "$RUNS/qwen2.5-1.5b-instruct-q4_k_m"
echo "SMALL-MODELS-COMPLETE"
