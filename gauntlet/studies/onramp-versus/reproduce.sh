#!/bin/bash
# Reproduce the on-ramp-versus rung-gap measurement for tictactoe and
# connect4. Deterministic, offline, no API keys, no paid calls.
#
# The measurement file (rung-gaps.json) is derived from the committed
# calibration tables; step 1 re-measures them. Re-rendering the global
# calibration/REPORT.md requires a full 13-game run (chess needs the
# Stockfish environment), so this script re-measures the two games and
# verifies the tracked report still matches the committed tables.
set -euo pipefail
cd "$(dirname "$0")/../.."   # gauntlet/

# 1. Re-measure the two games into the tracked tables directory, writing the
#    two-game report to a temp path (the tracked REPORT.md is re-rendered by
#    hand over all committed tables; see README).
node calibration/run.js --games=tictactoe,connect4 --out=calibration/tables \
  --report=/tmp/onramp-versus-partial-report.md

# 2. Recompute the rung-gap measurement file.
node studies/onramp-versus/rung-gaps.mjs

# 3. The tracked report must still match the committed tables (section
#    presence + the recomputed checks list).
node --test calibration/calibration.test.js
