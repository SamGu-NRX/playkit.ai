#!/bin/bash
# Reproduce the model-separation-v2 solo study's statistics from the committed
# run bundles — no model files, no server, no downloads.
#
# 1. Verifies every committed bundle (manifest hash + all episodes replayed).
# 2. Regenerates stats.json from the bundles and compares it byte for byte
#    with the committed stats.json.
#
# Usage: bash reproduce.sh   (run from anywhere; deps must be installed:
#                             cd gauntlet && npm ci)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GDIR="$(cd "$HERE/../../.." && pwd)"
cd "$GDIR"

echo "== bundle verify =="
for dir in "$HERE"/runs/*/*/ "$HERE"/runs-random/*/; do
  [ -d "$dir" ] || continue
  node cli/gauntlet.js bundle verify "$dir"
done

echo "== regenerate stats.json =="
node "$HERE/compute-stats.mjs" --out "$HERE/stats.regenerated.json"

if cmp -s "$HERE/stats.json" "$HERE/stats.regenerated.json"; then
  echo "stats.json reproduces byte for byte"
  rm "$HERE/stats.regenerated.json"
else
  echo "MISMATCH: regenerated stats.json differs from the committed file" >&2
  diff "$HERE/stats.json" "$HERE/stats.regenerated.json" | head -40 >&2 || true
  exit 1
fi
