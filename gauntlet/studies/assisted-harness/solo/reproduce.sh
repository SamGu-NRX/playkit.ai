#!/bin/bash
# Reproduce the community-assisted solo study end to end on this box.
# Requires: the three Qwen2.5 GGUFs under /home/user/work/gauntlet-models and
# llama.cpp b11662's llama-server under /home/user/burst7-model-store (sandbox
# assets, not committed). Wall time ~25 min on the 2-core sandbox; 7B
# mastermind dominates (~36 min at low memory, see REPORT.md -- adjust).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/run-assisted-small.sh"
bash "$HERE/run-assisted-7b.sh"
node "$HERE/compute-stats.mjs"
echo "reproduce: compare stats.json against the committed copy (byte-identical expected)"
