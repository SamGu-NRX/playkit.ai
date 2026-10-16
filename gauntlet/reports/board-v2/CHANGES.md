# What moved from the wave-6 board — CHANGES

Board v2 re-runs the same one-seed-per-tier public suite on the corrected benchmark
(`obv/burst7-playkit-integration-2`). This file records which rows of the wave-6 board
(`../first-model-run/`, PR #41) no longer match the published game versions, and why.
The wave-6 board stays in place untouched as the historical record.

## The suite itself

| | wave-6 (`first-model-run`) | board-v2 (this report) |
|---|---|---|
| Registered games | 12 | **13** (chess-puzzles joined) |
| Episodes (1 seed/tier) | 42 | **49** |
| Manifest | `61c34a9aa1118f981e96f061…` | `61fddda7a4a933e8abb68c76647a1abefd726c129f0b02b1db1ca5368bdbd75c` |

The six added episodes are chess-puzzles r0400–r2600 (new game) and chess-stockfish
sf-250 (new tier, rank 1 — the ladder gained a weakest rung).

## Games whose tiers changed (re-run required)

Five games re-tiered between wave 6 and this base — their wave-6 rows do not describe
the published games any more:

- **chess v1.0.0 → v1.1.0** — the engine ladder was rebuilt (`engine.js` rewrite, new
  `ladder.js` + `LADDER.md`); the four tier opponents are different engines/strengths,
  so model-vs-ladder outcomes are not comparable with wave 6.
- **connect4 v1.0.0 → v1.1.0** — opponent-ladder recalibration (PR #37): the forced-win
  tier's advertised win band moved from 7–15 to 17–21 plies and the retry pass now
  re-rolls within that same band instead of accepting 5–21, so every forced-win episode
  is a deeper, exactly-defended win than on wave 6.
- **holdem v1.0.0 → v1.1.0** — rules-bot recalibration (PR #37): the bot now treats any
  raise as aggression (was: two), defends its whole chart facing a raise, calls down
  one-pair and ace-high — closing the fold-equity leaks that uniform play exploited, so
  the station/rules/equity tier outcomes change.
- **minesweeper v1.0.0 → v1.1.0** — mine-density retune: the corrected tiers re-roll
  every board, and the wave-6 calibrated random means per tier (beginner 0.6625,
  intermediate 0.3535, torus 0.4122, expert 0.1351 — see `../FLOOR-OPTIONS.md`) no
  longer describe the published game.
- **sliding v1.0.0 → v1.1.0** — the solver's optimality fix moved `p15-short` par
  (28 → 26 on the public seed), so efficiency scores on that tier are not comparable.

## Game whose observation changed (tiers unchanged)

- **tictactoe v1.0.0 → v1.1.0** — board labels now match the action grammar
  (`obv/burst7-playkit-core-replay-fixes`, PR #33); the tier set is identical, but the
  model sees a different observation, so its wave-6 row is stale too. The harness
  fixture was re-recorded under 1.1.0 (PR #46).

## Verifier change

- **core/trajectory.js** — the replay verifier now re-derives the runner's decisions
  instead of trusting recorded step metadata (PR #33). Every board-v2 bundle here was
  verified with the corrected verifier; wave-6 bundles predate it and are kept as-is.

## Scoring-surface changes (new on this base, absent from wave 6)

- Three selectable scoring profiles: `rhae-v1` (default), `chance-adjusted`,
  `squared-outcome` — see `../FLOOR-OPTIONS.md` and `DECISIONS.md` §1.
- Chess rating surface: `rate` command + `rating/ladder-results.json` (anchored
  Bradley–Terry ladder, 240 episodes, Stockfish 17.1) — display-only.

## What was re-run vs reused

Everything on the corrected benchmark was re-run: the model (49/49 episodes) and all
17 baseline campaigns (random + greedy/engine × 8 games) on the new suite, scored
under all three profiles. Nothing from the wave-6 board is reused as data; the
wave-6 frontier projection and estimator study are reused only as the methodology
(and as the estimator-error bracket) cited in `DECISIONS.md` §2.
