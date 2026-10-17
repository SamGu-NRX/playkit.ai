#!/usr/bin/env bash
# `estimate.sh` — costed estimates for every committed suite option, one per
# frontier model (REPORT.md "Costed suite options"). --no-probes keeps the
# estimate free: a probe is a paid provider call. Prices come from the
# committed reports/release/prices.frontier.json. Options and models are
# enumerated from the committed suites; a re-cut flows through automatically.
#
# Usage: ./estimate.sh   (from gauntlet/studies/separation-pilot)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
g="$(cd "$here/../.." && pwd)"            # the gauntlet package root
cd "$here"

prices="$g/reports/release/prices.frontier.json"
mkdir -p outputs/estimates

models=(anthropic/claude-opus-5-5 openai/gpt-6-astra openai-chat/gemini-4-argon)

for suitePath in outputs/suites/suite.*.json; do
  option="$(basename "$suitePath" .json)"
  option="${option#suite.}"
  for model in "${models[@]}"; do
    out="outputs/estimates/${option}.${model//\//_}.json"
    echo "=== estimate $option on $model ==="
    node "$g/cli/gauntlet.js" estimate \
      --suite "$suitePath" \
      --agent "model:$model" \
      --prices "$prices" \
      --no-probes --json > "$out"
    node -e '
      const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const t = e.totals;
      const low = t.noLowBasis.length ? ` (no low basis: ${t.noLowBasis.join(", ")})` : "";
      console.log(`jobs ${t.jobs}, calls ${t.callsLow}-${t.callsHigh}, $${t.usdLow.toFixed(2)}-$${t.usdHigh.toFixed(2)}${low}`);
    ' "$out"
  done
done
echo "estimates: $(ls outputs/estimates/*.json | wc -l) files in outputs/estimates/"
