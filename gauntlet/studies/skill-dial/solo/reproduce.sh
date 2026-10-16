#!/bin/bash
# Reproduce the solo skill-dial study end to end and verify byte-stability.
#
#   ./studies/skill-dial/solo/reproduce.sh
#
# Environment: node >= 20, python3, npm. Runs from anywhere; cd's to the
# gauntlet/ directory.
#
# Steps:
#   1. npm ci (skipped when node_modules already exists)
#   2. snapshot the committed results.json and REPORT.md
#   3. run every episode into $RUNS_DIR (default /tmp/skill-dial-solo-runs);
#      existing complete episode files are skipped, so a re-run on the same
#      machine re-verifies quickly — set FRESH=1 to wipe and re-run everything
#   4. score through scoring/score.js (mirror cross-check enforced)
#   5. compute pooled statistics + regenerate REPORT.md
#   6. cmp both regenerated files against the snapshots
#
# Byte-for-byte: episode outputs are deterministic (fixed wall clock, seeded
# RNG), score() CIs are seeded, and compute-stats.py seeds every resample —
# so step 6 must pass. Exit non-zero otherwise.
set -euo pipefail

GAUNTLET="$(cd "$(dirname "$0")/../../.." && pwd)"
SOLO="$GAUNTLET/studies/skill-dial/solo"
RUNS="${RUNS_DIR:-/tmp/skill-dial-solo-runs}"

cd "$GAUNTLET"

if [ ! -d node_modules ]; then
  npm ci
fi

cp "$SOLO/results.json" /tmp/skill-dial-solo-results-committed.json
cp "$SOLO/REPORT.md" /tmp/skill-dial-solo-report-committed.md

if [ "${FRESH:-0}" = "1" ]; then
  node "$SOLO/run-study.mjs" --out "$RUNS" --workers "${WORKERS:-6}" --fresh
else
  node "$SOLO/run-study.mjs" --out "$RUNS" --workers "${WORKERS:-6}"
fi
node "$SOLO/score-study.mjs" --runs "$RUNS" --out "$SOLO"
python3 "$SOLO/compute-stats.py"

cmp /tmp/skill-dial-solo-results-committed.json "$SOLO/results.json" \
  && echo "reproduce: results.json is byte-identical"
cmp /tmp/skill-dial-solo-report-committed.md "$SOLO/REPORT.md" \
  && echo "reproduce: REPORT.md is byte-identical"
