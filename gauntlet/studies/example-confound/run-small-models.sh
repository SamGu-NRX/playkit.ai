#!/bin/bash
# Arms 1+2 (corrected-official, corrected-assisted) and arm 4 (connect4-neutral)
# for the 0.5B and 1.5B models, back to back (server restarted per model).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS="$HERE/runs"
printf 'corrected-official mastermind/mini 8\ncorrected-assisted mastermind/mini 8\nconnect4-neutral connect4/ladder-1 12\n' > /tmp/example-confound-arms-small.txt
bash "$HERE/serve-and-run.sh" qwen2.5-0.5b-instruct-q4_k_m /tmp/example-confound-arms-small.txt "$RUNS/qwen2.5-0.5b-instruct-q4_k_m"
bash "$HERE/serve-and-run.sh" qwen2.5-1.5b-instruct-q4_k_m /tmp/example-confound-arms-small.txt "$RUNS/qwen2.5-1.5b-instruct-q4_k_m"
echo "SMALL-MODELS-COMPLETE"
