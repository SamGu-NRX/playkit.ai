# Gauntlet calibration report

Baseline calibration over the gauntlet's public seeds: every game is played by a random, a greedy and an engine baseline through the same core runner and scored by the package's own scoring rules. This is the first evidence that the tier ladders mean something — a tier ordering that even uniform play breaks is a tier ordering no agent ranking can stand on.

> **What this report can and cannot tell you.** The checks below validate *baseline* ordering: random ≤ greedy ≤ engine per tier, non-rising random/greedy scores as tier rank rises, and ≥95% engine solves on efficiency tiers. That is evidence the tiers are ordered and solvable, not that the ladder discriminates between agents stronger than the engine — a ladder whose rungs only separate agents above the engine would pass here and still be useless. The evidence that would break the premise: any monotonic rise for random or greedy with rank, or greedy beating engine on a tier; both appear in the checks section with the parameter change they suggest.

## Run

| | |
|---|---|
| Run at | 2026-10-16T13:44:34.842Z |
| Node | v20.20.2 |
| Machine | linux 6.1.158+ x64, Intel(R) Xeon(R) Processor @ 2.60GHz, 8 cores, 7.8 GiB |
| Worker parallelism | 7 |
| Seeds per tier | all public seeds |
| Per-game wall cap | 1200s |
| Total wall time | 4742.8s |
| HEAD | 810ae663bee3 |
| Base | unknown |

Reproduce from `gauntlet/` with `node calibration/run.js` (flags: `--games=`, `--seeds=`, `--per-game-cap=`, `--out=`, `--report=`). One worker process per game; deterministic end to end — same seeds and code produce byte-identical tables.

## Tables

### 2048 (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| t256 (1) | outcome | 0.384 [0.28, 0.513] | 0.798 [0.661, 0.935] | 1 [1, 1] | — |
| t512 (2) | outcome | 0.234 [0.209, 0.261] | 0.412 [0.311, 0.535] | 0.968 [0.905, 1] | — |
| t1024 (3) | outcome | 0.191 [0.171, 0.211] | 0.258 [0.23, 0.285] | 1 [1, 1] | — |
| t2048 (4) | outcome | 0.125 [0.109, 0.142] | 0.208 [0.183, 0.233] | 0.774 [0.639, 0.905] | — |

_Run:_ 240 episodes, 16.4s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### chess-endgames (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| kqk (1) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| krk (2) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| kbbk (3) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| kbnk (4) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |

_Run:_ 120 episodes, 43.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ Packet-native baselines: `greedy` is a seeded mobility-greedy attacker; `engine` is the packet's tablebase-optimal agent — it plays the exact DTM line, so it converts every public seed at par and its efficiency score is the 1.0 ceiling.

### chess-puzzles (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| r0400 (1) | outcome | 0 [0, 0] | 0.067 [0.017, 0.133] | 0.9 [0.817, 0.967] | — |
| r1000 (2) | outcome | 0 [0, 0] | 0.05 [0, 0.117] | 0.767 [0.65, 0.867] | — |
| r1400 (3) | outcome | 0.017 [0, 0.05] | 0 [0, 0] | 0.65 [0.533, 0.767] | — |
| r1800 (4) | outcome | 0 [0, 0] | 0.067 [0.017, 0.133] | 0.383 [0.267, 0.5] | — |
| r2200 (5) | outcome | 0 [0, 0] | 0.017 [0, 0.05] | 0.117 [0.033, 0.2] | — |
| r2600 (6) | outcome | 0 [0, 0] | 0 [0, 0] | 0.05 [0, 0.117] | — |

_Run:_ 1080 episodes, 12.2s.

❌ **b-monotonic** — greedy rises from 0 [0, 0] on r1400 (rank 3) to 0.066667 [0.016667, 0.133333] on r1800 (rank 4)

  _Proposal:_ re-tune chess-puzzles's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 4 is at least as hard as rank 3 for greedy play

⚠️ **a-order (within noise)** — greedy 0 [0, 0] < random 0.016667 [0, 0.05] on tier r1400 (rank 3)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

⚠️ **b-monotonic (within noise)** — random rises from 0 [0, 0] on r1000 (rank 2) to 0.016667 [0, 0.05] on r1400 (rank 3)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

_Baselines:_ `greedy` and `engine` are the chess packet's material-capture greedy and fixed-strength engine agents (the pairing the puzzles packet itself reports); the tier ladder is the puzzle rating, so engine strength degrades with rating while greedy stays near the floor.

### chess-stockfish (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| sf-250 (1) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| sf-1k (2) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| sf-10k (3) | outcome | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | — |
| sf-100k (4) | outcome | 0 [0, 0] | 0 [0, 0] | 0.7 [0.5, 0.9] | — |
| sf-1m (5) | outcome | 0 [0, 0] | 0 [0, 0] | 0.5 [0.5, 0.5] | — |

_Run:_ 75 episodes, 3528.1s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ `greedy` is the chess packet's material-capture agent; `engine` is full node-budget Stockfish (the sf-1m ceiling rung) playing as the agent, so the ladder runs from uniform play to the strongest local engine as the opponent rungs rise.

### chess (v1.2.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| sand (1) | outcome | 0.8 [0.6, 1] | 0.7 [0.5, 0.9] | 1 [1, 1] | — |
| paper (2) | outcome | 0 [0, 0] | 0 [0, 0] | 0.4 [0.1, 0.7] | — |
| wood (3) | outcome | 0 [0, 0] | 0 [0, 0] | 0.4 [0.2, 0.5] | — |
| steel (4) | outcome | 0 [0, 0] | 0 [0, 0] | 0.7 [0.3, 1] | — |
| granite (5) | outcome | 0 [0, 0] | 0 [0, 0] | 0.7 [0.3, 1] | — |

_Run:_ 75 episodes, 426.7s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

⚠️ **a-order (within noise)** — greedy 0.7 [0.5, 0.9] < random 0.8 [0.6, 1] on tier sand (rank 1)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

### connect4 (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| ladder-1 (1) | outcome | 0.417 [0.167, 0.667] | 1 [1, 1] | 1 [1, 1] | — |
| ladder-0 (2) | outcome | 0 [0, 0] | 0.219 [0.063, 0.438] | 0.906 [0.75, 1] | — |
| ladder-2 (3) | outcome | 0 [0, 0] | 0.5 [0.25, 0.75] | 0.917 [0.792, 1] | — |
| ladder-3 (4) | outcome | 0 [0, 0] | 0.292 [0.083, 0.542] | 0.833 [0.583, 1] | — |
| ladder-4 (5) | outcome | 0 [0, 0] | 0.375 [0.125, 0.625] | 0.875 [0.667, 1] | — |
| forced-win (6) | outcome | 0.042 [0, 0.125] | 0.083 [0, 0.208] | 1 [1, 1] | — |

_Run:_ 228 episodes, 57.1s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

⚠️ **b-monotonic (within noise)** — random rises from 0 [0, 0] on ladder-4 (rank 5) to 0.041667 [0, 0.125] on forced-win (rank 6)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

⚠️ **b-monotonic (within noise)** — greedy rises from 0.21875 [0.0625, 0.4375] on ladder-0 (rank 2) to 0.5 [0.25, 0.75] on ladder-2 (rank 3)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

⚠️ **b-monotonic (within noise)** — greedy rises from 0.291667 [0.083333, 0.541667] on ladder-3 (rank 4) to 0.375 [0.125, 0.625] on ladder-4 (rank 5)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

### cube (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| cube-2 (1) | efficiency | 0 [0, 0] | 0.625 [0.375, 0.875] | 1 [1, 1] | 100% |
| cube-5 (2) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| cube-7 (3) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| cube-9 (4) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 102 episodes, 3.3s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ Packet-native baselines: `greedy` takes the one-ply move that most increases matched-facelet count with seeded tie-breaks; `engine` replays a proven-optimal solved line (re-solving from live facelets if the state ever leaves it).

### holdem (v1.3.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| station (1) | outcome | 0.019 [0.005, 0.038] | 0.668 [0.434, 0.876] | 0.869 [0.744, 0.966] | — |
| rules (2) | outcome | 0.014 [0.004, 0.03] | 0.52 [0.279, 0.755] | 0.901 [0.764, 0.987] | — |
| equity (3) | outcome | 0.031 [0.003, 0.077] | 0.176 [0.007, 0.411] | 0.329 [0.125, 0.561] | — |

_Run:_ 108 episodes, 26.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

⚠️ **b-monotonic (within noise)** — random rises from 0.013901 [0.003515, 0.030342] on rules (rank 2) to 0.030808 [0.002825, 0.077091] on equity (rank 3)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

### mastermind (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| mini (1) | efficiency | 0.03 [0, 0.08] | 0.724 [0.591, 0.855] | 1 [1, 1] | 100% |
| classic (2) | efficiency | 0 [0, 0] | 0.909 [0.831, 0.982] | 1 [1, 1] | 100% |
| wide (3) | efficiency | 0 [0, 0] | 0.817 [0.73, 0.909] | 1 [1, 1] | 100% |
| deep (4) | efficiency | 0 [0, 0] | 0.883 [0.791, 0.968] | 1 [1, 1] | 100% |

_Run:_ 300 episodes, 25.2s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

⚠️ **b-monotonic (within noise)** — greedy rises from 0.723733 [0.590564, 0.855458] on mini (rank 1) to 0.909378 [0.830711, 0.982] on classic (rank 2)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

⚠️ **b-monotonic (within noise)** — greedy rises from 0.817146 [0.729755, 0.908667] on wide (rank 3) to 0.883068 [0.791221, 0.968436] on deep (rank 4)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

### minesweeper (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| beginner (1) | outcome | 0.663 [0.592, 0.73] | 1 [1, 1] | 1 [1, 1] | — |
| intermediate (2) | outcome | 0.354 [0.293, 0.414] | 1 [1, 1] | 1 [1, 1] | — |
| torus (3) | outcome | 0.188 [0.156, 0.223] | 1 [1, 1] | 1 [1, 1] | — |
| expert (4) | outcome | 0.135 [0.102, 0.173] | 1 [1, 1] | 1 [1, 1] | — |

_Run:_ 300 episodes, 43.9s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ `greedy` is the packet's probability agent (proven-safe cells first, lowest mine-probability cell when deduction stalls); `engine` is the packet's deduction agent (plays only proven-safe cells — the no-guess guarantee).

### nonogram (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| tiny (1) | efficiency | 0 [0, 0] | 1 [1, 1] | 1 [1, 1] | 100% |
| classic (2) | efficiency | 0 [0, 0] | 1 [1, 1] | 1 [1, 1] | 100% |
| grand (3) | efficiency | 0 [0, 0] | 1 [1, 1] | 1 [1, 1] | 100% |
| probe (4) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 300 episodes, 33.2s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### othello (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| ladder-1 (1) | outcome | 0.542 [0.25, 0.792] | 0.833 [0.583, 1] | 1 [1, 1] | — |
| ladder-2 (2) | outcome | 0 [0, 0] | 0.208 [0, 0.458] | 1 [1, 1] | — |
| ladder-3 (3) | outcome | 0 [0, 0] | 0 [0, 0] | 0.917 [0.75, 1] | — |
| ladder-4 (4) | outcome | 0 [0, 0] | 0 [0, 0] | 0.542 [0.292, 0.792] | — |

_Run:_ 144 episodes, 157.1s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### sliding (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| p8-short (1) | efficiency | 0 [0, 0] | 0.568 [0.34, 0.79] | 1 [1, 1] | 100% |
| p8 (2) | efficiency | 0 [0, 0] | 0.165 [0, 0.415] | 1 [1, 1] | 100% |
| p15-short (3) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| p15-mid (4) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| p15-long (5) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 144 episodes, 37.3s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ The sliding packet ships no greedy baseline: `greedy` here minimizes total Manhattan distance to goal with seeded tie-breaks; `engine` is the packet's optimal-line solver agent.

### sokoban (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| one-box (1) | efficiency | 0 [0, 0] | 0.215 [0.066, 0.388] | 1 [1, 1] | 100% |
| two-box (2) | efficiency | 0 [0, 0] | 0.092 [0.022, 0.189] | 1 [1, 1] | 100% |
| three-box (3) | efficiency | 0 [0, 0] | 0.04 [0, 0.121] | 1 [1, 1] | 100% |
| four-box (4) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 273 episodes, 306.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### sudoku (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| mini-4x4 (1) | efficiency | 0 [0, 0] | 1 [1, 1] | 1 [1, 1] | 100% |
| easy (2) | efficiency | 0 [0, 0] | 1 [1, 1] | 1 [1, 1] | 100% |
| medium (3) | efficiency | 0 [0, 0] | 0.36 [0.199, 0.56] | 1 [1, 1] | 100% |
| hard (4) | efficiency | 0 [0, 0] | 0.2 [0.04, 0.36] | 0.48 [0.28, 0.68] | 48% |

_Run:_ 300 episodes, 9s.

❌ **c-solved** — engine solves 0.48 of seeds on efficiency tier hard (rank 4); floor is 0.95

  _Proposal:_ raise sudoku/hard maxActions above 5×par, strengthen the engine/reference solver in tier.params, or lower the tier's par band

### tictactoe (v1.2.0, benchmark: false — smoke game, not scored on the gauntlet leaderboard)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| random-opponent (1) | outcome | 0.469 [0.25, 0.688] | 0.844 [0.719, 0.938] | 0.969 [0.906, 1] | — |
| blunder-opponent (2) | outcome | 0.188 [0.063, 0.344] | 0.625 [0.5, 0.75] | 0.688 [0.563, 0.813] | — |
| perfect-opponent (3) | outcome | 0.063 [0, 0.188] | 0.438 [0.313, 0.5] | 0.5 [0.5, 0.5] | — |

_Run:_ 120 episodes, 6.6s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ No packet baselines ship for tictactoe (a smoke game): `greedy` here is a win/block/center heuristic with seeded tie-breaks, `engine` is perfect minimax over the game's own `step` and `outcome`.

### wordle (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| four-letter-10 (1) | efficiency | 0 [0, 0] | 0.551 [0.419, 0.696] | 1 [1, 1] | 100% |
| classic (2) | efficiency | 0 [0, 0] | 0.689 [0.568, 0.814] | 1 [1, 1] | 100% |
| hard-mode (3) | efficiency | 0.218 [0.089, 0.37] | 0.818 [0.69, 0.94] | 1 [1, 1] | 100% |

_Run:_ 225 episodes, 9.3s.

❌ **b-monotonic** — random rises from 0 [0, 0] on classic (rank 2) to 0.217833 [0.089378, 0.369691] on hard-mode (rank 3)

  _Proposal:_ re-tune wordle's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 3 is at least as hard as rank 2 for random play

⚠️ **b-monotonic (within noise)** — greedy rises from 0.551427 [0.419326, 0.696334] on four-letter-10 (rank 1) to 0.688956 [0.568032, 0.813659] on classic (rank 2)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

⚠️ **b-monotonic (within noise)** — greedy rises from 0.688956 [0.568032, 0.813659] on classic (rank 2) to 0.817978 [0.6897, 0.940083] on hard-mode (rank 3)

  _Why not a violation:_ the 95% intervals do not separate (they overlap, or a side has no interval), so the misordering is not demonstrated at the measured precision; re-measure at more seeds before changing tier parameters.

## Checks

3 violation(s) across 3 game(s). Each violation names the parameter it suggests changing; a violation is a calibration finding about tier parameters, not a scoring-rules bug — the scoring rules are the package's own and are shared with the leaderboard.

- **chess-puzzles — b-monotonic** (r1800): greedy rises from 0 [0, 0] on r1400 (rank 3) to 0.066667 [0.016667, 0.133333] on r1800 (rank 4)
- **sudoku — c-solved** (hard): engine solves 0.48 of seeds on efficiency tier hard (rank 4); floor is 0.95
- **wordle — b-monotonic** (hard-mode): random rises from 0 [0, 0] on classic (rank 2) to 0.217833 [0.089378, 0.369691] on hard-mode (rank 3)

Warnings — point inversions within noise (the 95% intervals do not separate; the rule is documented in calibration/checks.js):

- ⚠️ chess-puzzles — a-order (r1400): greedy 0 [0, 0] < random 0.016667 [0, 0.05] on tier r1400 (rank 3)
- ⚠️ chess-puzzles — b-monotonic (r1400): random rises from 0 [0, 0] on r1000 (rank 2) to 0.016667 [0, 0.05] on r1400 (rank 3)
- ⚠️ chess — a-order (sand): greedy 0.7 [0.5, 0.9] < random 0.8 [0.6, 1] on tier sand (rank 1)
- ⚠️ connect4 — b-monotonic (forced-win): random rises from 0 [0, 0] on ladder-4 (rank 5) to 0.041667 [0, 0.125] on forced-win (rank 6)
- ⚠️ connect4 — b-monotonic (ladder-2): greedy rises from 0.21875 [0.0625, 0.4375] on ladder-0 (rank 2) to 0.5 [0.25, 0.75] on ladder-2 (rank 3)
- ⚠️ connect4 — b-monotonic (ladder-4): greedy rises from 0.291667 [0.083333, 0.541667] on ladder-3 (rank 4) to 0.375 [0.125, 0.625] on ladder-4 (rank 5)
- ⚠️ holdem — b-monotonic (equity): random rises from 0.013901 [0.003515, 0.030342] on rules (rank 2) to 0.030808 [0.002825, 0.077091] on equity (rank 3)
- ⚠️ mastermind — b-monotonic (classic): greedy rises from 0.723733 [0.590564, 0.855458] on mini (rank 1) to 0.909378 [0.830711, 0.982] on classic (rank 2)
- ⚠️ mastermind — b-monotonic (deep): greedy rises from 0.817146 [0.729755, 0.908667] on wide (rank 3) to 0.883068 [0.791221, 0.968436] on deep (rank 4)
- ⚠️ wordle — b-monotonic (classic): greedy rises from 0.551427 [0.419326, 0.696334] on four-letter-10 (rank 1) to 0.688956 [0.568032, 0.813659] on classic (rank 2)
- ⚠️ wordle — b-monotonic (hard-mode): greedy rises from 0.688956 [0.568032, 0.813659] on classic (rank 2) to 0.817978 [0.6897, 0.940083] on hard-mode (rank 3)
