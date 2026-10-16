# Chess engine ladder

Head-to-head games between adjacent built-in engine tiers, refereed by the
game module itself. This is the measurement behind the ladder ordering claim
in the chess game README: each tier is expected to beat the tier below it, and
the benchmark measures how decisively.

## Running

```sh
node games/chess/ladder.js              # default: 24 games per adjacent pair
node games/chess/ladder.js --games=12   # fewer games per pair
```

The script is Node-only (it forks a worker pool) and prints a markdown
report. Games are fully deterministic: fixed episode seeds (`ladder/<tier>/<n>`),
alternating colours, each seat driven by its tier's engine agent, so reruns
reproduce the tables below exactly on the same hardware class.

## What one game is

- Both seats are tier engines from `game.opponent(tier, seed, seat)`; the
  stronger rung's seat alternates by game index.
- Each engine acts until natural termination or until it has used its own
  tier's `maxActions` budget; a still-running episode is truncation-adjudicated
  exactly like a real agent episode (500cp quiescence threshold).
- Score for the pair = mean normalized score of the **higher** rung (win 1,
  draw 0.5, loss 0). The reported interval is a Wilson 95% interval computed
  on the per-game mean; with draws in the mix this is a Wilson-style interval
  on a {0, 0.5, 1}-valued mean, not an exact binomial Wilson interval, so
  treat the bounds as approximate.

## Latest results (24 games per pair, both colours)

| Pair (higher > lower) | Higher-rung score | Wilson 95% | Terminations | Avg plies | Avg game time |
| --- | --- | --- | --- | --- | --- |
| wood > paper | 0.813 / 24 | [0.618, 0.921] | threefold:9 checkmate:15 | 99.5 | 2.4s |
| steel > wood | 0.667 / 24 | [0.467, 0.820] | checkmate:14 threefold:10 | 101.8 | 7.1s |
| granite > steel | 0.771 / 24 | [0.573, 0.894] | threefold:11 checkmate:13 | 116.4 | 21.0s |

Point estimates order all three pairs the same way, and wood>paper and
granite>steel are resolved with intervals clear of 0.5. steel>wood is NOT
resolved at 24 games: its Wilson lower bound (0.467) spans 0.5, so this sample
cannot distinguish wood from steel — consistent with the caveat below, and a
reminder that a missing result here means the sample is too small, not that
the rungs are equal. Average seconds per move per tier: paper 0.02s, wood
0.05s, steel 0.13s, granite 0.18s — note the per-tier timing splits each
game's wall time evenly between the two engines, so these are approximations
(a tier that finishes its moves early still accrues half the game's remaining
wait). Full 72-game run: 141s wall time on an 8-core machine with 6 workers.

Read the intervals, not the point estimates: with 24 games a pair, a 0.667 is
statistically consistent with a 0.85. What the table pins is *ordering*, not
exact strength gaps. For absolute strength on a common scale (including
Stockfish rungs), use the rating calibration tooling in `rating/`, which
consumes these same seeded head-to-head games.

## Engine performance context

The search was rewritten (pseudo-legal generation with lazy legality, bounded
transposition table, principal-variation search, history quiet-move ordering,
late-move reductions) and the game module gained per-state position/repetition
caches. Profiling on an exploratory middlegame fixture measured best-move
times going from ~53ms/447ms/2321ms/5633ms (paper/wood/steel/granite; granite
stopping at depth 4) to ~25ms/84ms/512ms/1097ms with granite completing depth
5 within its 160,000-node budget, and a 30-ply conformance-style episode
dropping from ~1317ms to ~90ms. The referee/adjudication fix (black-to-move
quiescence perspective) and the king-phase material pre-pass change outcomes
in a small set of positions; a 60-position old-vs-new decision diff across
tiers, seeds, and openings produced 0 differing best moves, and the suite
pins perft, truncation, mirror symmetry, and state/cache consistency.
