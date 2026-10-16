#!/bin/bash
# Run the 0.5B and 1.5B assisted ladders back to back (server restarted per
# model), 8 public seeds on the two tiers that produced the separation-v2
# conclusions: mastermind/mini (the invalid-rate tier, random mean 0.0298)
# and minesweeper/beginner (the only score-discriminating tier, random mean
# 0.6625). The four zero-floor tiers stay covered by the unassisted arm's
# evidence; assisted sliding 0.5B measured ~20 min/episode on this 2-core
# box and was cut for budget (recorded in REPORT.md).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$HERE/runs"
printf 'mastermind/mini 8\nminesweeper/beginner 8\n' > /tmp/assisted-specs-small.txt
bash "$HERE/serve-and-run-assisted.sh" qwen2.5-0.5b-instruct-q4_k_m /tmp/assisted-specs-small.txt "$RUNS/qwen2.5-0.5b-instruct-q4_k_m"
bash "$HERE/serve-and-run-assisted.sh" qwen2.5-1.5b-instruct-q4_k_m /tmp/assisted-specs-small.txt "$RUNS/qwen2.5-1.5b-instruct-q4_k_m"
echo "SMALL-MODELS-COMPLETE"
