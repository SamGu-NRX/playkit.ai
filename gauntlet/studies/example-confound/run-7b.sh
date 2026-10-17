#!/bin/bash
# Arm 3 (corrected-official, all 8 seeds) then arm 4's 7B run. Per the
# preregistration's drop order, arm 4's 7B is the first thing dropped when
# time runs short, so it runs last; arm 3's seeds 0-7 all precede it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$HERE/runs"
printf 'corrected-7b mastermind/mini 8\nconnect4-neutral connect4/ladder-1 12\n' > /tmp/example-confound-arms-7b.txt
bash "$HERE/serve-and-run.sh" qwen2.5-7b-instruct-q4_k_m /tmp/example-confound-arms-7b.txt "$RUNS/qwen2.5-7b-instruct-q4_k_m"
echo "7B-COMPLETE"
