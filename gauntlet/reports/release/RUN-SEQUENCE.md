# Run sequence — how the release board's trajectories were produced

The release board re-uses every board-v2 trajectory that is still verifiable on
the final tree and re-plays only what the tree changed. This file is the audit
trail: what was reused, what was replayed, what failed and why, and every
server deviation.

## Base

- Tree: `obv/burst8-playkit-integration-3` at `a5ab54e`, merged with
  `obv/burst7-playkit-board-v2` (report tree only) on branch
  `obv/burst8-playkit-release-board`.
- Suite: `suite.release.json`, rebuilt on the final tree with
  `gauntlet suite build --split public --seeds-per-tier 1` — 13 games, 49
  jobs, the same game/tier/seed set as board-v2's pilot with three games at
  new versions: tictactoe 1.1.0 → **1.2.0**, holdem 1.1.0 → **1.2.0**
  (the committed random-public scoring baseline was regenerated to match,
  see `../scoring/baselines/random-public.json` sha 6a18bcca…), cube
  1.0.0 → **1.1.0**.

## Board-v2 bundle verification (pre-splice)

`gauntlet verify` over all 18 board-v2 run dirs on the final tree: 13 returned
`verdict ok`; four were refused (run-qwen, run-random, run-greedy-holdem,
run-engine-holdem) because their run manifests pin the old game versions — the
*trajectories* inside them verify, the manifest as a whole cannot; and
`run-engine-chess` failed score recomputation (the documented CLI limitation
with recalibrated chess tiers). The splice therefore copies trajectories into
fresh run dirs whose manifests are rebuilt on the final tree.

## Reuse and replay

Per-run provenance is in `runs/<name>/run.json` (counts: planned / played /
skipped-verified-on-resume / replayed). Summary:

- **Reused as-is (verified in place):** every episode whose game version
  matches the final tree (chess, chess-endgames, chess-stockfish, chess-puzzles,
  connect4, minesweeper, sliding, sokoban, mastermind, 2048) — 46 of 49 qwen
  episodes (the seven changed-game replays from the first resume verified and
  count as reused), 42 of 49 random episodes, and all per-game baseline
  campaigns except the two holdem ones. Copied from
  `reports/board-v2/runs/`, then `gauntlet run --resume` re-verified each
  trajectory against the final-tree code (deterministic replay: same seed,
  same recorded actions, same end state) and marked it skipped. The final
  ledger is `run-ledger.md`.
- **Replayed fresh:** the episodes whose game versions changed —
  run-random: tictactoe/perfect-opponent (1.2.0), cube cube-5/7/9 (1.1.0),
  holdem station/rules/equity (1.2.0), 7 episodes; run-qwen: the same seven
  on the first resume, plus a second replay of the three holdem episodes
  after the context-size failure documented below; run-greedy-holdem and
  run-engine-holdem, 3 episodes each, deterministic baselines on holdem 1.2.0.

## Serving the model runs

- llama.cpp `b11662` built from source; llama-server, one model at a time:
  `--temp 0.0 --seed 42 --threads 8` — identical sampling settings to the
  model-separation study and board-v2.
- Model: `Qwen2.5-1.5B-Instruct-Q4_K_M`, SHA-256 `6a1a2eb6…9407e` verified
  against `studies/model-separation/models.sha256`.
- **Deviation (documented):** the first rerun pass served
  `--ctx-size 4096` (board-v2's setting). The three holdem episodes failed
  with `Context size has been exceeded` (llama-server HTTP 500): llama-server
  is not bit-deterministic across processes, the rerun's dialogues diverged
  longer than board-v2's, and the conversations outgrew 4096 tokens. The
  holdem episodes were re-served at `--ctx-size 8192` and completed. Sampling
  settings did not change; only the hard context ceiling moved, which does not
  alter the model's distribution. The episode-level evidence of the divergence
  is in the fresh holdem trajectories (call counts vs board-v2's are in
  `usage-qwen.json`).

## Final verification

`gauntlet verify` over every release run dir — results in
`bundle-verify-all.txt` — and the leaderboard/score regenerations in this
directory. Every run must return `episodes N/N verified / verdict ok` before
the board's numbers are read.

## Leaderboard regeneration notes

- The CLI buckets entries by agent identity (`agent.id` + track). Two
  campaigns record the same identity `sliding-solver` (run-greedy-sliding and
  run-engine-sliding: the greedy and engine skill-dial aliases resolve to the
  same solver agent). Merging them produces one entry with two trajectories
  for each sliding episode, which the scorer refuses (`duplicate-episodes`) —
  by design, since one entry cannot honestly contain the same episode twice.
  The two campaigns' trajectories are identical action-for-action (diffs are
  timestamps and step timings only), so the merged boards include
  run-engine-sliding as the sliding-solver representative; run-greedy-sliding
  is verified in `bundle-verify-all.txt` and adds no measurable information.
- The `chance-adjusted` profile initially refused every board with
  `baseline-version`: the committed `scoring/baselines/random-public.json`
  pinned holdem 1.1.0 / tictactoe 1.1.0 / cube 1.0.0. It was regenerated from
  the final-tree calibration tables with `scoring/generate-baseline.js`
  (sha256 6a18bcca…) and all three profiles were then regenerated — the
  refusal fired exactly as the baseline-staleness protection is designed to.
