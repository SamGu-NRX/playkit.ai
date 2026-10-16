# Gauntlet chess ratings

Maximum-likelihood Elo-style ratings for gauntlet chess rungs, with
uncertainty intervals, plus scripts that produce them from played games.

## `elo.js` — the fitting module

Ratings use the Elo scale: the expected score of `a` against `b` is

```
expectedScore(ratingA, ratingB) = 1 / (1 + 10^((ratingB - ratingA) / 400))
```

draws count half a point. Internally the fitter works in natural-logit units
(`rating = x / LOGIT_SCALE` with `LOGIT_SCALE = 400 / ln(10)`), which makes the
likelihood concave — one unique maximum, no local optima.

- `expectedScore(a, b)` — logistic expected score on the Elo scale.
- `twoPlayerFit(totalScore, games, { anchorRating })` — closed-form rating for
  one agent against a single fixed anchor opponent, from the score equation
  `s - n·E(r) = 0`. Reports `direction: 'wins-everything' | 'loses-everything'`
  and `rating: null` when the score is 0 or n (no finite MLE).
- `fitRatings(games, { anchorPlayer, anchorRating })` — multi-player anchored
  MLE over games `{ a, b, score }` (score is `a`'s result). Damped Newton with
  an exact line search, run to a gradient infinity-norm below `1e-10`. The
  anchor player's rating is fixed, which identifies the otherwise
  translation-invariant scale. Throws `EloFitError` with
  `code: 'DIVERGENT'` (some player or connected group won/lost every game —
  the likelihood keeps improving along a diverging direction) or
  `'UNIDENTIFIED'` (the game graph does not connect every player to the
  anchor).
- `bootstrapRatings(games, { anchorPlayer, anchorRating, replicates, seed })`
  — nonparametric bootstrap: resample games with replacement, refit, report
  percentile intervals. Replicates whose fit diverges are discarded and
  counted in `divergentReplicates` (an all-wins replicate means an unbounded
  interval end; it contributes no finite percentile). Reproducible through
  the seeded RNG in `core/rng.js`.
- `rateAgent(trajectories, ladder, options)` — rate a single agent's recorded
  trajectories (any tier of any game in the ladder) against the fitted ladder,
  with bootstrap interval and divergence direction.

## Scripts

### `ladder.js` — the anchored ladder run

Plays every adjacent ladder pair (plus the `paper`–`sf-1k` skip pair) with
balanced colours on the seeded episode runner, fits the anchored MLE, and
writes `ladder-results.json` with per-game results, raw scores, fit and
bootstrap intervals, and provenance (engine id, spec versions, git commit).
With `--merge-from=PATH` a partial run carries a prior results file's pairs
into the fit, so a new rung is rated without replaying the old pairs.

```
node rating/ladder.js [--games-per-colour=20] [--replicates=2000]
                      [--pairs=csv] [--merge-from=PATH] [--builtin-only]
                      [--out=PATH]
```

Rungs and pairs:

| pair | game | agent rung | opponent rung |
|---|---|---|---|
| sand-vs-paper | chess | chess-sand | chess-paper |
| paper-vs-wood | chess | chess-wood | chess-paper |
| wood-vs-sf-250 | chess-stockfish | chess-wood | chess-stockfish-sf-250 |
| sf-1k-vs-sf-10k | chess-stockfish | sf-1k | sf-10k |
| sf-10k-vs-sf-100k | chess-stockfish | sf-10k | sf-100k |
| skip-paper-vs-sf-1k | chess-stockfish | chess-paper | sf-1k |

The anchor is `chess-paper = 1000`; every other rating is measured. Raw game
results are written to disk before the fit runs, so a divergent fit (possible
for tiny one-sided samples) never costs the games.

### `absolute.js` — UCI_Elo calibration onto the gauntlet scale

Loads the ladder results, plays Stockfish agents limited by the documented
`UCI_LimitStrength`/`UCI_Elo` options against known rungs (`chess-wood` and
`chess-stockfish-sf-1k`), refits everything in one anchored MLE, and reports
each level's rating on the gauntlet scale in `absolute-results.json`.

```
node rating/absolute.js [--games-per-colour=8] [--levels=1320,1500,...]
                        [--replicates=2000] [--ladder-results=PATH] [--out=PATH]
```

**Interpretation caveat.** Stockfish documents UCI_Elo against CCRL blitz
ratings at time control 120+1s (Stockfish PR #4341), with roughly ±100 Elo
uncertainty in that setting. The calibration games use a fixed 1000-node
search budget per move — far faster than the documented control — so the
resulting mapping places the labelled strengths on our anchored scale and is
indicative only. It is not a CCRL-equivalent rating, and comparisons to
published human or engine Elo lists are meaningless.

## Reproducibility

- Every episode's seed is recorded in the results JSON (`rating/<pairId>/<k>`);
  seats come from the game's own `agentSeat(tier, seed)` and are balanced per
  colour.
- Built-in engine tiers and the Stockfish node-budget tiers (single thread,
  16 MB hash, `go nodes`) are deterministic for a given engine binary, so a
  rerun with the same binary replays results exactly. The binary identity
  (`probeEngineIdSync`) is recorded in each results file.
- Bootstrap fits are reproducible through their documented seed strings.
- Results JSON files carry: anchor, spec versions, engine id, git commit and
  branch, `finishedAt`, per-game seeds, seats, scores and termination reasons.
