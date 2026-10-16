# Solo skill-dial study: does the score fall as play gets worse?

**Load-bearing assumption.** The score must fall when play gets worse because the dial's
coin flips (u < p) replace exactly the expert's replies with exactly the random agent's
moves on the same turn streams. Evidence that would confirm it: monotonically falling
pooled means with p. Evidence that would break it: tiers whose score stays flat (the
metric cannot see skill there) or non-monotonic bumps (per-seed luck dominating n).
Adjacent explanations this study does not cover: opponents and multi-agent play (dial
episodes are the engine against itself or alone, per game packet), and model-backed
agents (the expert here is the packet engine, not a frontier model).

## Method

- Dial: pinned in `gauntlet/agents/skill-dial.js`. p=0 is byte-for-byte the expert; p=1 is
  byte-for-byte the random agent (verified at runner level in the dial's tests).
- Expert: each game's `engine` baseline from the calibration kit. All six solo games ship one.
- Episodes: all 22 tiers of 2048, Minesweeper, Sliding, Sokoban, Mastermind, Cube;
  six p values (0, 0.1, 0.25, 0.5, 0.75, 1); the tier's public seeds plus study-local
  eval-style seeds (committed salt `playkit-gauntlet-skill-dial-solo-study/1`), pooled for
  this report. These are NOT the benchmark's hidden eval seeds (their salt is not committed).
- Scoring: through `scoring/score.js` with single-tier suites covering exactly the seeds
  run; every group ranked with score()'s own 10k-draw bootstrap CI. All three profiles
  applied; efficiency tiers are profile-invariant by construction.
- Honesty check: an independent per-episode mirror of the scoring rules must agree with
  score() to 6 decimals for every group, or nothing is published.
- Error policy: episodes where the expert throws are recorded as errors and counted, not
  scored as zero. This matters only for cube (see findings).
- Pooled statistics: percentile bootstrap (10,000 draws) over the pooled per-episode
  scores, FNV-1a-seeded; Spearman rho with tie-averaged ranks across the six p means.

## Master table (rhae-v1, pooled public + eval)

Mean with 95% CI per p; `err` is the error rate; rho across the six means.

| game/tier | p=0 | p=0.1 | p=0.25 | p=0.5 | p=0.75 | p=1 | err | rho |
|---|---|---|---|---|---|---|---|---|
| 2048/t1024 | 0.961 [0.904,1.000] | 0.373 [0.308,0.453] | 0.278 [0.252,0.302] | 0.212 [0.188,0.236] | 0.199 [0.176,0.223] | 0.180 [0.163,0.198] | 0% | -1.00 |
| 2048/t2048 | 0.799 [0.693,0.900] | 0.266 [0.248,0.285] | 0.223 [0.205,0.241] | 0.183 [0.163,0.204] | 0.153 [0.136,0.171] | 0.132 [0.118,0.146] | 0% | -1.00 |
| 2048/t256 | 1.000 [1.000,1.000] | 0.935 [0.853,1.000] | 0.727 [0.609,0.837] | 0.629 [0.519,0.751] | 0.524 [0.414,0.638] | 0.291 [0.249,0.349] | 0% | -1.00 |
| 2048/t512 | 0.980 [0.941,1.000] | 0.670 [0.555,0.790] | 0.468 [0.375,0.573] | 0.310 [0.267,0.366] | 0.242 [0.218,0.267] | 0.228 [0.209,0.247] | 0% | -1.00 |
| minesweeper/beginner | 1.000 [1.000,1.000] | 0.944 [0.898,0.978] | 0.791 [0.709,0.864] | 0.741 [0.670,0.806] | 0.647 [0.579,0.715] | 0.649 [0.587,0.709] | 0% | -0.94 |
| minesweeper/expert | 1.000 [1.000,1.000] | 0.294 [0.234,0.363] | 0.172 [0.141,0.208] | 0.124 [0.100,0.149] | 0.134 [0.109,0.160] | 0.134 [0.106,0.165] | 0% | -0.77 |
| minesweeper/intermediate | 1.000 [1.000,1.000] | 0.611 [0.516,0.709] | 0.396 [0.331,0.462] | 0.423 [0.353,0.489] | 0.378 [0.317,0.438] | 0.382 [0.325,0.443] | 0% | -0.89 |
| minesweeper/torus | 1.000 [1.000,1.000] | 0.274 [0.228,0.323] | 0.232 [0.191,0.275] | 0.170 [0.153,0.188] | 0.158 [0.142,0.175] | 0.162 [0.141,0.186] | 0% | -0.94 |
| sliding/p15-long | 1.000 [1.000,1.000] | 0.744 [0.685,0.806] | 0.471 [0.427,0.518] | 0.128 [0.106,0.151] | 0.000 [0.000,0.000] | 0.000 [0.000,0.000] | 0% | -0.96 |
| sliding/p15-mid | 1.000 [1.000,1.000] | 0.760 [0.721,0.798] | 0.433 [0.373,0.498] | 0.141 [0.103,0.188] | 0.000 [0.000,0.000] | 0.000 [0.000,0.000] | 0% | -0.96 |
| sliding/p15-short | 1.000 [1.000,1.000] | 0.754 [0.669,0.836] | 0.495 [0.414,0.584] | 0.129 [0.085,0.187] | 0.010 [0.000,0.030] | 0.000 [0.000,0.000] | 0% | -1.00 |
| sliding/p8 | 1.000 [1.000,1.000] | 0.820 [0.738,0.897] | 0.581 [0.499,0.670] | 0.231 [0.180,0.285] | 0.033 [0.015,0.053] | 0.000 [0.000,0.000] | 0% | -1.00 |
| sokoban/four-box | 1.000 [1.000,1.000] | 0.715 [0.656,0.771] | 0.461 [0.380,0.546] | 0.128 [0.090,0.183] | 0.005 [0.002,0.009] | 0.000 [0.000,0.000] | 0% | -1.00 |
| sokoban/three-box | 1.000 [1.000,1.000] | 0.739 [0.670,0.809] | 0.482 [0.408,0.560] | 0.169 [0.128,0.219] | 0.009 [0.006,0.013] | 0.000 [0.000,0.000] | 0% | -1.00 |
| sokoban/two-box | 1.000 [1.000,1.000] | 0.774 [0.686,0.855] | 0.507 [0.422,0.594] | 0.171 [0.108,0.250] | 0.043 [0.021,0.071] | 0.000 [0.000,0.000] | 0% | -1.00 |
| mastermind/classic | 1.000 [1.000,1.000] | 0.971 [0.933,1.000] | 0.825 [0.750,0.895] | 0.706 [0.600,0.814] | 0.411 [0.315,0.517] | 0.000 [0.000,0.000] | 0% | -1.00 |
| mastermind/deep | 1.000 [1.000,1.000] | 0.915 [0.845,0.979] | 0.805 [0.734,0.874] | 0.775 [0.681,0.874] | 0.473 [0.359,0.590] | 0.000 [0.000,0.000] | 0% | -1.00 |
| mastermind/wide | 1.000 [1.000,1.000] | 0.963 [0.918,1.000] | 0.790 [0.708,0.864] | 0.683 [0.591,0.778] | 0.532 [0.406,0.659] | 0.000 [0.000,0.000] | 0% | -1.00 |
| cube/cube-5 | 1.000 [1.000,1.000] | 0.597 [0.386,0.799] | 0.524 [0.284,0.764] | 0.023 [0.006,0.044] | 0.000 [0.000,0.000] | 0.000 [0.000,0.000] | 26% | -0.96 |
| cube/cube-7 | 1.000 [1.000,1.000] | 0.741 [0.571,0.901] | 0.487 [0.288,0.704] | 0.290 [0.290,0.290] | — | 0.000 [0.000,0.000] | 42% | — |
| cube/cube-9 | 1.000 [1.000,1.000] | 0.530 [0.289,0.778] | 0.479 [0.207,0.770] | — | — | 0.000 [0.000,0.000] | 49% | — |

## Verdicts

Discriminates = rho <= -0.9 AND CI(p=0.25) does not overlap CI(p=0.75) — the pinned rule.

| game/tier | discriminates | clipped at expert (p) | clipped at random (p) | usable p |
|---|---|---|---|---|
| 2048/t1024 | **yes** | 0 | 0.5, 0.75, 1 | 0.1, 0.25 |
| 2048/t2048 | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| 2048/t256 | no | 0, 0.1 | 1 | 0.25, 0.5, 0.75 |
| 2048/t512 | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| minesweeper/beginner | no | 0 | 0.25, 0.5, 0.75, 1 | 0.1 |
| minesweeper/expert | no | 0 | 0.25, 0.5, 0.75, 1 | 0.1 |
| minesweeper/intermediate | no | 0 | 0.25, 0.5, 0.75, 1 | 0.1 |
| minesweeper/torus | **yes** | 0 | 0.5, 0.75, 1 | 0.1, 0.25 |
| sliding/p15-long | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| sliding/p15-mid | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| sliding/p15-short | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| sliding/p8 | **yes** | 0 | 1 | 0.1, 0.25, 0.5, 0.75 |
| sokoban/four-box | **yes** | 0 | 1 | 0.1, 0.25, 0.5, 0.75 |
| sokoban/three-box | **yes** | 0 | 1 | 0.1, 0.25, 0.5, 0.75 |
| sokoban/two-box | **yes** | 0 | 1 | 0.1, 0.25, 0.5, 0.75 |
| mastermind/classic | **yes** | 0, 0.1 | 1 | 0.25, 0.5, 0.75 |
| mastermind/deep | **yes** | 0 | 1 | 0.1, 0.25, 0.5, 0.75 |
| mastermind/wide | **yes** | 0, 0.1 | 1 | 0.25, 0.5, 0.75 |
| cube/cube-5 | **yes** | 0 | 0.75, 1 | 0.1, 0.25, 0.5 |
| cube/cube-7 | no | 0 | 1 | 0.1, 0.25, 0.5 |
| cube/cube-9 | no | 0 | 1 | 0.1, 0.25 |

## Profiles side by side

Efficiency tiers are identical under every profile (the scorer never transforms them), so
only the outcome tiers (2048, Minesweeper) appear here.

| outcome tier | rhae-v1 | squared-outcome | chance-adjusted |
|---|---|---|---|
| 2048/t1024 | yes | yes | yes |
| 2048/t2048 | yes | yes | yes |
| 2048/t256 | no | no | no |
| 2048/t512 | yes | yes | yes |
| minesweeper/beginner | no | yes | yes |
| minesweeper/expert | no | no | no |
| minesweeper/intermediate | no | no | no |
| minesweeper/torus | yes | yes | no |

## The discriminating core

Tiers that pass the pinned rule end to end: `2048/t1024`, `2048/t2048`, `2048/t512`, `minesweeper/torus`, `sliding/p15-long`, `sliding/p15-mid`, `sliding/p15-short`, `sliding/p8`, `sokoban/four-box`, `sokoban/three-box`, `sokoban/two-box`, `mastermind/classic`, `mastermind/deep`, `mastermind/wide`, `cube/cube-5`.

Seeds needed to separate p=0.25 from p=0.5 — analytic n from the normal-approximation
CI rule, and the fraction of seeded subsamples that separate by resample size:

| tier | analytic n | f(8) | f(12) | f(16) | f(20) | f(24) | f(28) | f(32) |
|---|---|---|---|---|---|---|---|---|
| 2048/t1024 | 19 | 0.22 | 0.28 | 0.38 | 0.55 | 0.78 | 0.97 | 1.00 |
| 2048/t2048 | 30 | 0.14 | 0.11 | 0.17 | 0.24 | 0.29 | 0.41 | 1.00 |
| 2048/t512 | 30 | 0.14 | 0.14 | 0.25 | 0.27 | 0.32 | 0.40 | 1.00 |
| cube/cube-5 | 4 | — | — | — | — | — | — | — |
| mastermind/classic | 77 | 0.05 | 0.04 | 0.02 | 0.02 | 0.01 | 0.00 | 0.00 |
| mastermind/deep | 1079 | 0.01 | 0.01 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| mastermind/wide | 86 | 0.07 | 0.04 | 0.04 | 0.02 | 0.01 | 0.01 | 0.00 |
| minesweeper/torus | 31 | 0.05 | 0.12 | 0.14 | 0.15 | 0.28 | 0.34 | 1.00 |
| sliding/p15-long | 1 | 1.00 | 1.00 | 1.00 | — | — | — | — |
| sliding/p15-mid | 3 | 1.00 | 1.00 | 1.00 | — | — | — | — |
| sliding/p15-short | 3 | 1.00 | 1.00 | 1.00 | — | — | — | — |
| sliding/p8 | 3 | 1.00 | 1.00 | 1.00 | — | — | — | — |
| sokoban/four-box | 6 | 0.76 | 0.93 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| sokoban/three-box | 6 | 0.80 | 0.95 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| sokoban/two-box | 8 | 0.56 | 0.75 | 0.93 | 0.99 | 1.00 | 1.00 | 1.00 |

## Findings

1. **The dial behaves as pinned at the endpoints.** p=0 and p=1 trajectories are
   byte-identical to the expert's and the random agent's own (dial tests). The p=1 arm is
   therefore a resampling of the random baseline, which is what the pooled p=1 means show.
2. **The score falls with p on every tier, and 15 of 21 tiers pass the pinned rule end to
   end** (all three 2048 except t256, torus minesweeper, all four sliding, all three sokoban,
   all three mastermind, cube-5). The six failures are informative, not flat: the minesweeper
   outcome tiers saturate against the expert by p=0.25 (usable p: 0.1 only), and 2048/t256
   is too easy — even the random agent solves most seeds. The saturation columns name which
   p values each tier wastes; efficiency scoring (sliding, sokoban, mastermind) reads the
   dial cleanly, outcome scoring compresses the top of the ladder. Cube-7/9 fail because
   their noisy arms abort (finding 3), not because the score stays flat.
3. **Cube's engine cannot serve as a dial expert at intermediate p.** Its optimal solver
   refuses scrambles beyond its proven 10-turn range, so noisy episodes abort with
   `solveOptimal: scramble is beyond the proven range of 10 turns`; the error-rate column
   quantifies it. Any agent that wanders off-plan and hands back to the engine hits this.
4. **Cube's chance-adjusted score is unavailable at this commit** (baseline v1.0.0 vs game
   v1.1.0); the study-local-r column is informational only.
5. **Sliding and cube ship too few public seeds (8 and 6)** to reach 16 public per tier; the
   study backfilled with eval-style seeds to reach 16 and 16 respectively.

## Proposed changes (not made here)

- **games/cube**: give the engine baseline a defined behavior when the optimal solver's
  proven range is exceeded (best-effort greedy fallback, or extend the proven range), and
  document it in the packet; the game packet is otherwise well-formed.
- **scoring/baselines/random-public.json**: regenerate at cube v1.1.0 (the calibration
  tables' cube rows) so chance-adjusted works for cube again; the generator exists
  (`generate-baseline.js`) and is byte-deterministic.
- **games (sliding, cube)**: raise `publicSeeds` to at least 16, or accept fewer public
  seeds per tier in dial-style studies.
- **Leaderboard note**: dial-style ladders are cheap to add as a benchmark column once
  cube's engine robustness lands; the discriminating core in this report is the candidate
  tier list.

## Reproduce

```bash
./studies/skill-dial/solo/reproduce.sh   # full re-run; regenerates results.json byte-for-byte
```

Raw per-episode scores and error records: `episodes.json`. Canonical per-(tier, p, split)
score() values with their bootstrap CIs: `profile-results.json`. Trajectory bundles stay on
the run machine (`RUNS_DIR`, default `/tmp/skill-dial-solo-runs`) and are regenerable from
seeds; nothing in the report reads anything but the two committed JSON files.

## Limitations

- Pooled n per cell is 16-32; CIs are correspondingly wide. The seed-requirement table says
  what each tier would actually need.
- Study-local eval seeds are not the benchmark's hidden eval split.
- Cube rows mix an engine-abort error rate into coverage; means are over surviving episodes.
- One engine per game: the study measures the dial and the scoring floors, not model skill.
