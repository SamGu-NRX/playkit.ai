# Chess rating ladder — anchored ratings

Anchored Bradley–Terry ratings over the chess rung ladder, fitted from the
six-pair colour-symmetric match series played by `rating/ladder.js`. This is
the machine-readable companion to `rating/ladder-results.json`; the `gauntlet
rate` command and the leaderboard's chess rating column load the JSON file
(override the path with `--ladder`).

## Provenance

| Field | Value |
|---|---|
| Produced by | `node rating/ladder.js` (deterministic for a given engine binary) |
| Finished at | 2026-10-16T05:19:15.600Z |
| Engine | Stockfish 17.1 (`/usr/games/stockfish`) |
| Games | chess v1.1.0, chess-stockfish v1.0.0 |
| Match design | 6 adjacent pairs × 2 colours × 20 games per colour = 240 episodes |
| Anchor | chess-paper pinned at 1000 |
| Fit | Bradley–Terry MLE, 16 iterations (gradient ‖∞‖ 1.15e-10); bootstrap 2000 replicates, 1999 used, 1 divergent replicate discarded |
| Branch / base commit | `obv/burst7-playkit-integration-2` @ 4f7ef3e2c664 |

## Ratings (Elo, anchor chess-paper = 1000)

| Rung | Rating | 95% CI (bootstrap) |
|---|---|---|
| chess-paper (random baseline) | 1000 | 1000–1000 |
| chess-wood (deterministic built-in engine) | 1361 | 1266–1520 |
| chess-stockfish-sf-250 | 1603 | 1464–1805 |
| chess-stockfish-sf-1k | 2172 | 1980–2460 |
| chess-stockfish-sf-10k | 2809 | 2546–3157 |
| chess-stockfish-sf-100k | 3320 | 3015–3766 |

Ratings increase strictly along the ladder. At 95% separation, the middle
engine rungs separate (chess-stockfish-sf-250 vs sf-1k, and sf-1k vs sf-10k),
while the paper→wood→sf-250 spacing and the sf-10k→sf-100k step have overlapping
intervals — directionally supported, not separated.

## Pair results

- **paper-vs-wood** — chess-wood vs chess-paper: agent score 0.887 over 40 games (20 per colour).
- **wood-vs-sf-250** — chess-wood vs chess-stockfish-sf-250: agent score 0.200 over 40 games (20 per colour).
- **sf-250-vs-sf-1k** — chess-stockfish-sf-250 vs chess-stockfish-sf-1k: agent score 0.037 over 40 games (20 per colour).
- **sf-1k-vs-sf-10k** — chess-stockfish-sf-1k vs chess-stockfish-sf-10k: agent score 0.025 over 40 games (20 per colour).
- **sf-10k-vs-sf-100k** — chess-stockfish-sf-10k vs chess-stockfish-sf-100k: agent score 0.050 over 40 games (20 per colour).
- **skip-paper-vs-sf-1k** — chess-paper vs chess-stockfish-sf-1k: agent score 0.000 over 40 games (20 per colour).

## Usage

- `node cli/gauntlet.js rate <trajectory-dirs...>` — rates agents against this
  ladder (rung lookup: `<game.id>-<tier>`; non-chess trajectories are skipped
  and reported per agent).
- `node cli/gauntlet.js leaderboard <dirs...>` — shows the chess rating column
  when `rating/ladder-results.json` is present next to the suite.
- Regenerate both files together: run `rating/ladder.js`, then update this
  document from the new results (numbers above are generated, never edited by
  hand).
