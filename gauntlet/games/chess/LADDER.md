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
  draw 0.5, loss 0), with a Wilson 95% interval over the games.

## Latest results (24 games per pair, both colours)

| Pair (higher > lower) | Higher-rung score | Wilson 95% | Terminations | Avg plies | Avg game time |
| --- | --- | --- | --- | --- | --- |
| wood > paper | 0.854 / 24 | [0.665, 0.945] | checkmate:17 threefold:7 | 93.5 | 5.2s |
| steel > wood | 0.708 / 24 | [0.508, 0.851] | checkmate:12 material:1 threefold:11 | 93.8 | 10.9s |
| granite > steel | 0.792 / 24 | [0.595, 0.908] | checkmate:16 threefold:8 | 110.7 | 31.5s |

Every adjacent pair is ordered with the Wilson lower bound above 0.5, so the
ladder has no inversions at this sample size. Average seconds per move per
tier: paper 0.06s, wood 0.09s, steel 0.21s, granite 0.28s. Full 72-game run:
207s wall time on an 8-core machine with 6 workers.

Read the intervals, not the point estimates: with 24 games a pair, a 0.708 is
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
