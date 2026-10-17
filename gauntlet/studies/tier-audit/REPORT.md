# Tier audit: which gauntlet tiers separate skill, and which reward no-skill play

Question: can a tier tell a stronger deterministic player from a weaker one at
realistic seed counts — and does a tier reward a player that does not engage with
the game at all? Every registered game tier (18 games, 76 tiers) is audited with
three scripted agents and, where an engine baseline exists, three skill-dial
settings.

## Cells

Re-derived at the current game versions on this branch: every cell was
re-checked (a cell counts only when every planned seed has a trajectory
recording the registry’s current game version), cells whose game version
had moved (mastermind 1.1.0, wordle 1.2.0) or whose trajectories were
untracked were re-played, and the tables below are that re-audit.

- `copy-example` — plays the rules-text documented example token when it is
  exactly legal, else the first legal action. A stronger-than-nothing player that
  only reads the docs.
- `first-legal` — always the first legal action. Pure no-skill floor.
- `dial-0` / `dial-0.5` / `dial-1` — the game's own baseline agent with expert
  blending p=0 (random), p=0.5 (half expert), p=1 (random again). Skill must show
  as dial-0.5 strictly between the two random endpoints.

Dial cells are reused from the committed skill-dial solo study where that study
covered the tier at every p on the same public seeds and game version
(`cellSources: skill-dial-solo`). Cells that cannot exist are recorded as
`not-applicable` with the reason in tiers.json (tictactoe/chess-puzzles/
chess-stockfish ship no baseline agents; cube/cube-5..9 dial-0.5 exceeds the
expert solver's proven scramble range; sudoku dial-0.5 hits solver contradictions
on half-mixed states).

## Statistics

Cell values mirror the official scoring layer exactly (verified by 614
`score()` mirror checks in compute-tiers): efficiency tiers publish
`min(solvedFraction, mean e)` under every profile; outcome tiers publish the
mean of the profile-transformed episode scores. CIs are seeded percentile
bootstraps (10k draws): plain mean resampling for outcome tiers, joint
`(e, solved)` resampling of the capped statistic for efficiency tiers.
Exploitability: paired bootstrap of `no-skill − dial-1` (both are random-policy
episodes; a positive gap means the tier rewards not engaging). Power: paired
gap tests report the seeds needed for two-sided alpha 0.05.

Headline counts: 72 usable tiers, 12 flagged
(76 total). Seeds per tier: the tier's full public seed list
(12–60; chess-puzzles tiers n=60).

## Flags (the short answer)

- **Exploitable tiers** — a no-skill strategy's paired CI clears zero over the
  dial-1 random endpoint: 2048 (all four tiers), chess-endgames/kqk,
  connect4/ladder-1, holdem/station, holdem/rules. On these tiers a player that
  does not engage with the game scores significantly above the random endpoint.
- **Luck-dominated tiers** — dial-0 and dial-1 random-policy CIs overlap
  (skill signal unreachable at the audit's seed budget): chess/sand,
  go/ladder-1, go/ladder-2, go/ladder-4.

## Full table

Values are `rhae-v1` (`squared-outcome` and `chance-adjusted` in tiers.json).
`dial-0.5` is the only column where skill can appear: it must beat both random
endpoints by more than the CIs. `exploit` columns show the paired no-skill
advantage over the random endpoint (`dial-1`).

| game/tier | n | copy-example | first-legal | dial-0 | dial-0.5 | dial-1 | exploit copy | exploit first | flags |
|---|---|---|---|---|---|---|---|---|---|
| 2048/t256 | 20 | 0.590 [0.447, 0.739] | 0.590 [0.440, 0.733] | 1.000 [1.000, 1.000] | 0.532 [0.401, 0.674] | 0.384 [0.280, 0.507] | 0.206 [0.042, 0.370] | 0.206 [0.044, 0.367] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| 2048/t512 | 20 | 0.407 [0.307, 0.529] | 0.407 [0.307, 0.524] | 0.968 [0.905, 1.000] | 0.276 [0.244, 0.309] | 0.234 [0.209, 0.261] | 0.173 [0.071, 0.291] | 0.173 [0.072, 0.290] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| 2048/t1024 | 20 | 0.241 [0.212, 0.267] | 0.241 [0.213, 0.268] | 1.000 [1.000, 1.000] | 0.203 [0.171, 0.234] | 0.191 [0.171, 0.212] | 0.050 [0.021, 0.082] | 0.050 [0.021, 0.082] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| 2048/t2048 | 20 | 0.197 [0.175, 0.218] | 0.197 [0.176, 0.217] | — | 0.177 [0.155, 0.200] | 0.125 [0.109, 0.142] | 0.072 [0.047, 0.097] | 0.072 [0.046, 0.096] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| tictactoe/random-opponent | 0 | 0.594 [0.344, 0.813] | 0.594 [0.344, 0.813] | — | — | — | — | — | — |
| tictactoe/blunder-opponent | 0 | 0.375 [0.125, 0.625] | 0.375 [0.125, 0.625] | — | — | — | — | — | — |
| tictactoe/perfect-opponent | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess/sand | 5 | 0.200 [0.000, 0.400] | 0.200 [0.000, 0.400] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0.800 [0.600, 1.000] | -0.600 [-0.900, -0.300] | -0.600 [-0.900, -0.300] | luck-dominated, does-not-resolve-at-64 |
| chess/paper | 5 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.400 [0.100, 0.700] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| chess/wood | 5 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.400 [0.200, 0.500] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| chess/steel | 5 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.700 [0.300, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| chess/granite | 5 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.700 [0.300, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| chess-endgames/kqk | 10 | 0.019 [0.010, 0.029] | 0.019 [0.010, 0.029] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.019 [0.010, 0.029] | 0.019 [0.010, 0.029] | exploitable-by-copy-example, exploitable-by-first-legal |
| chess-endgames/krk | 10 | 0.002 [0.000, 0.005] | 0.002 [0.000, 0.005] | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.002 [0.000, 0.005] | 0.002 [0.000, 0.005] | resolves-at-12-or-fewer |
| chess-endgames/kbbk | 10 | 0.009 [0.000, 0.021] | 0.009 [0.000, 0.021] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.009 [0.000, 0.021] | 0.009 [0.000, 0.021] | — |
| chess-endgames/kbnk | 10 | 0.011 [0.000, 0.028] | 0.011 [0.000, 0.028] | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.011 [0.000, 0.028] | 0.011 [0.000, 0.028] | resolves-at-12-or-fewer |
| chess-stockfish/sf-1k | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-stockfish/sf-10k | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-stockfish/sf-100k | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-stockfish/sf-1m | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-stockfish/sf-250 | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-puzzles/r0400 | 0 | 0.033 [0.000, 0.083] | 0.033 [0.000, 0.083] | — | — | — | — | — | — |
| chess-puzzles/r1000 | 0 | 0.033 [0.000, 0.083] | 0.033 [0.000, 0.083] | — | — | — | — | — | — |
| chess-puzzles/r1400 | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-puzzles/r1800 | 0 | 0.017 [0.000, 0.050] | 0.017 [0.000, 0.050] | — | — | — | — | — | — |
| chess-puzzles/r2200 | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| chess-puzzles/r2600 | 0 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | — | — | — | — | — |
| cube/cube-2 | 16 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.165 [0.029, 0.347] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| cube/cube-5 | 6 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| cube/cube-7 | 6 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| cube/cube-9 | 6 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| go/ladder-1 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.750 [0.500, 1.000] | 0.833 [0.583, 1.000] | 0.542 [0.250, 0.792] | -0.542 [-0.833, -0.250] | -0.542 [-0.792, -0.250] | luck-dominated, does-not-resolve-at-64 |
| go/ladder-2 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.458 [0.208, 0.708] | 0.500 [0.250, 0.750] | 0.125 [0.000, 0.333] | -0.125 [-0.333, 0.000] | -0.125 [-0.333, 0.000] | luck-dominated, does-not-resolve-at-64 |
| go/ladder-3 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.583 [0.333, 0.833] | 0.500 [0.250, 0.750] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| go/ladder-4 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.458 [0.208, 0.750] | 0.583 [0.333, 0.833] | 0.250 [0.000, 0.500] | -0.250 [-0.500, 0.000] | -0.250 [-0.500, 0.000] | luck-dominated, does-not-resolve-at-64 |
| minesweeper/beginner | 25 | 0.528 [0.435, 0.617] | 0.528 [0.435, 0.617] | 1.000 [1.000, 1.000] | 0.699 [0.607, 0.784] | 0.663 [0.590, 0.731] | -0.135 [-0.216, -0.058] | -0.135 [-0.219, -0.057] | resolves-at-12-or-fewer |
| minesweeper/intermediate | 25 | 0.234 [0.184, 0.289] | 0.234 [0.185, 0.290] | 1.000 [1.000, 1.000] | 0.381 [0.314, 0.445] | 0.354 [0.290, 0.415] | -0.119 [-0.177, -0.067] | -0.119 [-0.176, -0.067] | resolves-at-12-or-fewer |
| minesweeper/torus | 25 | 0.186 [0.155, 0.221] | 0.186 [0.154, 0.221] | 1.000 [1.000, 1.000] | 0.187 [0.160, 0.217] | 0.188 [0.156, 0.224] | -0.002 [-0.028, 0.023] | -0.002 [-0.028, 0.024] | resolves-at-12-or-fewer |
| minesweeper/expert | 25 | 0.090 [0.068, 0.118] | 0.090 [0.068, 0.117] | 1.000 [1.000, 1.000] | 0.128 [0.101, 0.158] | 0.135 [0.101, 0.174] | -0.045 [-0.079, -0.017] | -0.045 [-0.080, -0.017] | resolves-at-12-or-fewer |
| sliding/p8-short | 16 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.268 [0.172, 0.395] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sliding/p8 | 8 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.249 [0.184, 0.316] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sliding/p15-short | 8 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.168 [0.096, 0.266] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sliding/p15-mid | 8 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.117 [0.082, 0.157] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sliding/p15-long | 8 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.114 [0.087, 0.143] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sokoban/one-box | 16 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.185 [0.107, 0.272] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sokoban/two-box | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.183 [0.101, 0.280] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| sokoban/three-box | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | 0.201 [0.149, 0.262] | — | — | — | — |
| sokoban/four-box | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | 0.157 [0.102, 0.226] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| connect4/ladder-1 | 12 | 0.917 [0.750, 1.000] | 0.833 [0.583, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0.417 [0.167, 0.667] | 0.500 [0.083, 0.833] | 0.417 [0.083, 0.750] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| connect4/ladder-0 | 16 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.906 [0.750, 1.000] | 0.188 [0.000, 0.375] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| connect4/ladder-2 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.917 [0.792, 1.000] | 0.250 [0.000, 0.500] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| connect4/ladder-3 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.833 [0.583, 1.000] | 0.208 [0.000, 0.458] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | does-not-resolve-at-64 |
| connect4/ladder-4 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.875 [0.667, 1.000] | 0.250 [0.000, 0.500] | — | — | — | resolves-at-12-or-fewer |
| connect4/forced-win | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.375 [0.125, 0.625] | — | — | — | resolves-at-12-or-fewer |
| mastermind/mini | 25 | 0.040 [0.000, 0.120] | 0.040 [0.000, 0.120] | 1.000 [1.000, 1.000] | 0.611 [0.478, 0.749] | 0.030 [0.001, 0.080] | 0.016 [-0.070, 0.132] | 0.016 [-0.072, 0.132] | resolves-at-12-or-fewer |
| mastermind/classic | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.785 [0.654, 0.912] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| mastermind/wide | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.742 [0.628, 0.852] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| mastermind/deep | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.790 [0.666, 0.909] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| holdem/station | 12 | 0.490 [0.382, 0.597] | 0.490 [0.379, 0.597] | 0.869 [0.745, 0.967] | 0.203 [0.094, 0.325] | 0.019 [0.005, 0.038] | 0.470 [0.363, 0.572] | 0.470 [0.367, 0.570] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| holdem/rules | 12 | 0.148 [0.072, 0.237] | 0.148 [0.072, 0.237] | 0.901 [0.759, 0.987] | 0.149 [0.073, 0.247] | 0.014 [0.004, 0.030] | 0.134 [0.060, 0.225] | 0.134 [0.059, 0.224] | exploitable-by-copy-example, exploitable-by-first-legal, resolves-at-12-or-fewer |
| holdem/equity | 12 | 0.121 [0.024, 0.225] | 0.121 [0.022, 0.226] | 0.329 [0.126, 0.557] | 0.098 [0.021, 0.197] | 0.031 [0.003, 0.078] | 0.090 [-0.022, 0.214] | 0.090 [-0.021, 0.214] | does-not-resolve-at-64 |
| nonogram/tiny | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.240 [0.080, 0.400] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| nonogram/classic | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.040 [0.000, 0.120] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| nonogram/grand | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| nonogram/probe | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] | — | — | — | resolves-at-12-or-fewer |
| sudoku/mini-4x4 | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| sudoku/easy | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| sudoku/medium | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| sudoku/hard | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | — | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| othello/ladder-1 | 12 | 0.458 [0.208, 0.750] | 0.458 [0.208, 0.750] | 1.000 [1.000, 1.000] | 0.750 [0.500, 1.000] | 0.542 [0.292, 0.833] | -0.083 [-0.500, 0.333] | -0.083 [-0.500, 0.333] | does-not-resolve-at-64 |
| othello/ladder-2 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| othello/ladder-3 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | 0.042 [0.000, 0.125] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — |
| othello/ladder-4 | 12 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.542 [0.292, 0.792] | 0.000 [0.000, 0.000] | — | — | — | resolves-at-12-or-fewer |
| wordle/four-letter-10 | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.593 [0.459, 0.728] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| wordle/classic | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.670 [0.565, 0.777] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |
| wordle/hard-mode | 25 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 1.000 [1.000, 1.000] | 0.142 [0.022, 0.285] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | resolves-at-12-or-fewer |

## Reproducing

Raw episode trajectories (165 MB, 5605 episodes) are re-derivable and not
committed; every cell bundle's run record and suite manifest are committed
under `bundles/`. From `gauntlet/` on alpha with the engine binaries installed
(`stockfish`, `gnugo`):

```sh
node studies/tier-audit/run-cells.mjs           # regenerate any missing bundles
sh studies/tier-audit/reproduce.sh              # replay-verify all bundles, regenerate tiers.json, diff byte-identical
node studies/tier-audit/render-report.mjs       # re-render this report from tiers.json
```

Engine opponents are GNU Go 3.8 and Stockfish 17.1; episodes are deterministic
per recorded engine version and public seeds.

