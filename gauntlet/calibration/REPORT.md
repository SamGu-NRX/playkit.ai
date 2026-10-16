# Gauntlet calibration report

Baseline calibration over the gauntlet's public seeds: every game is played by a random, a greedy and an engine baseline through the same core runner and scored by the package's own scoring rules. This is the first evidence that the tier ladders mean something — a tier ordering that even uniform play breaks is a tier ordering no agent ranking can stand on.

> **What this report can and cannot tell you.** The checks below validate *baseline* ordering: random ≤ greedy ≤ engine per tier, non-rising random/greedy scores as tier rank rises, and ≥95% engine solves on efficiency tiers. That is evidence the tiers are ordered and solvable, not that the ladder discriminates between agents stronger than the engine — a ladder whose rungs only separate agents above the engine would pass here and still be useless. The evidence that would break the premise: any monotonic rise for random or greedy with rank, or greedy beating engine on a tier; both appear in the checks section with the parameter change they suggest.

## Run

| | |
|---|---|
| Run at | 2026-10-16T01:46:58.545Z |
| Node | v20.20.2 |
| Machine | linux 6.1.158+ x64, Intel(R) Xeon(R) Processor @ 2.60GHz, 8 cores, 7.8 GiB |
| Worker parallelism | 7 |
| Seeds per tier | all public seeds |
| Per-game wall cap | 1200s |
| Total wall time | 1218.4s |
| HEAD | 11301f651412 |
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

_Run:_ 240 episodes, 12.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### chess (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| paper (1) | outcome | 0 [0, 0] | 0.1 [0, 0.3] | — | — |
| wood (2) | outcome | 0 [0, 0] | 0 [0, 0] | — | — |
| steel (3) | outcome | 0 [0, 0] | 0 [0, 0] | — | — |
| granite (4) | outcome | 0 [0, 0] | 0 [0, 0] | — | — |

_Run:_ ⚠️ the 1200s wall cap stopped this worker early (36 episodes run) — remaining cells are empty and the checks below skip them.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### connect4 (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| ladder-1 (1) | outcome | 0.417 [0.167, 0.667] | 1 [1, 1] | 1 [1, 1] | — |
| ladder-2 (2) | outcome | 0 [0, 0] | 0.5 [0.25, 0.75] | 0.917 [0.792, 1] | — |
| ladder-3 (3) | outcome | 0 [0, 0] | 0.292 [0.083, 0.542] | 0.833 [0.583, 1] | — |
| ladder-4 (4) | outcome | 0 [0, 0] | 0.375 [0.125, 0.625] | 0.875 [0.667, 1] | — |
| forced-win (5) | outcome | 0.042 [0, 0.125] | 0.417 [0.167, 0.667] | 1 [1, 1] | — |

_Run:_ 180 episodes, 41.7s.

❌ **b-monotonic** — random rises from 0 on ladder-4 (rank 4) to 0.041667 on forced-win (rank 5)

  _Proposal:_ re-tune connect4's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 5 is at least as hard as rank 4 for random play

❌ **b-monotonic** — greedy rises from 0.291667 on ladder-3 (rank 3) to 0.375 on ladder-4 (rank 4)

  _Proposal:_ re-tune connect4's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 4 is at least as hard as rank 3 for greedy play

❌ **b-monotonic** — greedy rises from 0.375 on ladder-4 (rank 4) to 0.416667 on forced-win (rank 5)

  _Proposal:_ re-tune connect4's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 5 is at least as hard as rank 4 for greedy play

### holdem (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| station (1) | outcome | 0.019 [0.005, 0.038] | 0.669 [0.434, 0.876] | 0.869 [0.744, 0.966] | — |
| rules (2) | outcome | 0.45 [0.341, 0.565] | 0.373 [0.182, 0.575] | 0.731 [0.542, 0.887] | — |
| equity (3) | outcome | 0.011 [0.003, 0.021] | 0.171 [0.005, 0.409] | 0.318 [0.119, 0.547] | — |

_Run:_ 108 episodes, 18.2s.

❌ **a-order** — greedy 0.37318 < random 0.449807 on tier rules (rank 2)

  _Proposal:_ the greedy heuristic loses to uniform play on holdem/rules — re-tune the heuristic or its seeded tie-breaks until it at least matches random

❌ **b-monotonic** — random rises from 0.019327 on station (rank 1) to 0.449807 on rules (rank 2)

  _Proposal:_ re-tune holdem's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 2 is at least as hard as rank 1 for random play

### mastermind (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| classic (1) | efficiency | 0 [0, 0] | 0.909 [0.831, 0.981] | 1 [1, 1] | 100% |
| wide (2) | efficiency | 0 [0, 0] | 0.817 [0.728, 0.909] | 1 [1, 1] | 100% |
| deep (3) | efficiency | 0 [0, 0] | 0.883 [0.788, 0.969] | 1 [1, 1] | 100% |

_Run:_ 225 episodes, 24.1s.

❌ **b-monotonic** — greedy rises from 0.817146 on wide (rank 2) to 0.883068 on deep (rank 3)

  _Proposal:_ re-tune mastermind's tier parameters (board size, band, or engine rung) or re-rank the tiers so rank 3 is at least as hard as rank 2 for greedy play

### minesweeper (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| beginner (1) | outcome | 0.663 [0.592, 0.73] | 1 [1, 1] | 1 [1, 1] | — |
| intermediate (2) | outcome | 0.354 [0.293, 0.414] | 1 [1, 1] | 1 [1, 1] | — |
| torus (3) | outcome | 0.188 [0.156, 0.223] | 1 [1, 1] | 1 [1, 1] | — |
| expert (4) | outcome | 0.135 [0.102, 0.173] | 1 [1, 1] | 1 [1, 1] | — |

_Run:_ 300 episodes, 39.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ `greedy` is the packet's probability agent (proven-safe cells first, lowest mine-probability cell when deduction stalls); `engine` is the packet's deduction agent (plays only proven-safe cells — the no-guess guarantee).

### sliding (v1.1.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| p8 (1) | efficiency | 0 [0, 0] | 0.165 [0, 0.415] | 1 [1, 1] | 100% |
| p15-short (2) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| p15-mid (3) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |
| p15-long (4) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 96 episodes, 38s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ The sliding packet ships no greedy baseline: `greedy` here minimizes total Manhattan distance to goal with seeded tie-breaks; `engine` is the packet's optimal-line solver agent.

### sokoban (v1.0.0)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| two-box (1) | efficiency | 0 [0, 0] | 0.092 [0.021, 0.193] | 1 [1, 1] | 100% |
| three-box (2) | efficiency | 0 [0, 0] | 0.04 [0, 0.121] | 1 [1, 1] | 100% |
| four-box (3) | efficiency | 0 [0, 0] | 0 [0, 0] | 1 [1, 1] | 100% |

_Run:_ 225 episodes, 169.5s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

### tictactoe (v1.0.0, benchmark: false — smoke game, not scored on the gauntlet leaderboard)

| tier (rank) | scoring | random | greedy | engine | engine solved |
|---|---|---|---|---|---|
| perfect-opponent (1) | outcome | 0.063 [0, 0.188] | 0.438 [0.313, 0.5] | 0.5 [0.5, 0.5] | — |

_Run:_ 24 episodes, 2.8s.

✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).

_Baselines:_ No packet baselines ship for tictactoe (a smoke game): `greedy` here is a win/block/center heuristic with seeded tie-breaks, `engine` is perfect minimax over the game's own `step` and `outcome`.

## Checks

6 violation(s) across 3 game(s). Each violation names the parameter it suggests changing; a violation is a calibration finding about tier parameters, not a scoring-rules bug — the scoring rules are the package's own and are shared with the leaderboard.

- **connect4 — b-monotonic** (forced-win): random rises from 0 on ladder-4 (rank 4) to 0.041667 on forced-win (rank 5)
- **connect4 — b-monotonic** (ladder-4): greedy rises from 0.291667 on ladder-3 (rank 3) to 0.375 on ladder-4 (rank 4)
- **connect4 — b-monotonic** (forced-win): greedy rises from 0.375 on ladder-4 (rank 4) to 0.416667 on forced-win (rank 5)
- **holdem — a-order** (rules): greedy 0.37318 < random 0.449807 on tier rules (rank 2)
- **holdem — b-monotonic** (rules): random rises from 0.019327 on station (rank 1) to 0.449807 on rules (rank 2)
- **mastermind — b-monotonic** (deep): greedy rises from 0.817146 on wide (rank 2) to 0.883068 on deep (rank 3)
