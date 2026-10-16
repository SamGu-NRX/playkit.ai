#!/bin/bash
# Reproduce the model-separation study end to end on one 8-core Linux box.
# Everything stays on 127.0.0.1; no API keys, no paid calls, no model files
# committed. Run from gauntlet/ after `npm ci`.
#
# Statistics only (no runs): regenerate stats.json from the committed run
# bundles beside the study manifest with
#   REPRODUCE_STATS_ONLY=1 bash reproduce.sh
set -euo pipefail

cd "$(dirname "$0")/../.."           # gauntlet/
STUDY=studies/model-separation
MODELS=${MODELS_DIR:-/home/user/work/gauntlet-models}
LLAMA=${LLAMA_SERVER:-/home/user/work/llamacpp/llama-b11662/llama-server}
RUNS=${RUNS_DIR:-/tmp/gauntlet-sep-runs}
SERVER_LOG=${SERVER_LOG:-/tmp/llama-server.log}

# 0. Statistics only: compute-stats.py defaults to the committed runs/ beside
#    the manifest, so this regenerates the study's stats.json from the files
#    shipped in the checkout and exits.
if [ "${REPRODUCE_STATS_ONLY:-0}" = "1" ]; then
  python3 "$STUDY/compute-stats.py"
  exit 0
fi

# 1. Suite manifest (7 short-episode tiers, 4 public seeds per tier).
#    build-suite.mjs writes beside the manifest, so the runs below consume the
#    manifest just generated, not a stale copy.
node "$STUDY/build-suite.mjs" 4

# 2. Baselines on the same jobs (no server needed).
node cli/gauntlet.js run --suite "$STUDY/suite.public.json" --agent random \
  --out "$RUNS/random" --max-calls 2500
for g in mastermind connect4 sliding sokoban minesweeper; do
  node cli/gauntlet.js run --suite "$STUDY/suite.public.json" \
    --agent "baseline:$g:greedy" --out "$RUNS/greedy-$g" --max-calls 2500
done
# Note: tictactoe ships no baseline agent and cube's baseline is not wired
# into the CLI's baseline spec map, so greedy covers five of the seven games.

# 3. Model runs: serve each model with identical settings, then run the same
#    suite through the official track. Temperature 0 and seed 42 are fixed on
#    the server; the CLI's openai-chat spec cannot pass per-request sampling
#    params, so identical server settings are what makes the three runs
#    comparable.
for m in qwen2.5-0.5b-instruct-q4_k_m qwen2.5-1.5b-instruct-q4_k_m qwen2.5-7b-instruct-q4_k_m; do
  "$LLAMA" -m "$MODELS/$m.gguf" --host 127.0.0.1 --port 8080 \
    --ctx-size 4096 --temp 0.0 --seed 42 --threads 8 > "$SERVER_LOG" 2>&1 &
  SRV=$!
  until curl -sf http://127.0.0.1:8080/health >/dev/null; do sleep 2; done
  curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null   # warm-up
  node cli/gauntlet.js run --suite "$STUDY/suite.public.json" \
    --agent "model:openai-chat/$m" --base-url http://127.0.0.1:8080 \
    --out "$RUNS/$m" --max-calls 2500
  kill $SRV; sleep 2
done

# 4. Verify every bundle and build the leaderboard.
for d in "$RUNS"/*; do node cli/gauntlet.js bundle verify "$d"; done
node cli/gauntlet.js leaderboard --suite "$STUDY/suite.public.json" \
  --out "$RUNS/leaderboard" "$RUNS"/*

# 5. Statistics from the runs this script produced. compute-stats.py expects
#    the study's short run-dir names (qwen2.5-0.5b, ...); the model runs above
#    write the full model file stem, so link them under a stats-input root
#    first. (A fresh full 7B run here plays sokoban, which #43's committed
#    part-1 run never did — see REPORT.md's 7B deviation note — so the fresh
#    stats.json can legitimately differ from the committed one on sokoban.)
STATS_IN="${RUNS}-stats-input"
rm -rf "$STATS_IN"; mkdir -p "$STATS_IN"
ln -s "$RUNS/qwen2.5-0.5b-instruct-q4_k_m" "$STATS_IN/qwen2.5-0.5b"
ln -s "$RUNS/qwen2.5-1.5b-instruct-q4_k_m" "$STATS_IN/qwen2.5-1.5b"
ln -s "$RUNS/qwen2.5-7b-instruct-q4_k_m" "$STATS_IN/qwen2.5-7b"
python3 "$STUDY/compute-stats.py" "$STATS_IN"
