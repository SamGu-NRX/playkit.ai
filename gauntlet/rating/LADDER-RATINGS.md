# Chess rating ladder — anchored ratings

Anchored Bradley–Terry ratings over the chess rung ladder, fitted from the
seven-pair colour-symmetric match series played by `rating/ladder.js`. This is
the machine-readable companion to `rating/ladder-results.json`; the `gauntlet
rate` command and the leaderboard's chess rating column load the JSON file
(override the path with `--ladder`).

## Provenance

| Field | Value |
|---|---|
| Produced by | `node rating/ladder.js --pairs=sand-vs-paper --merge-from=rating/ladder-results.json` (deterministic for a given engine binary) |
| Finished at | 2026-10-16T08:25:47.466Z |
| Engine | Stockfish 17.1 (`/usr/games/stockfish`) |
| Games | chess v1.2.0, chess-stockfish v1.0.0 |
| Match design | `sand-vs-paper` played fresh (2 colours × 20 games per colour = 40 episodes); the six pre-existing pairs (240 episodes) carried from the 2026-10-16T05:19:15Z run via `--merge-from` |
| Anchor | chess-paper pinned at 1000 |
| Fit | Bradley–Terry MLE, 28 iterations (gradient ‖∞‖ 5.6e-11); bootstrap 2000 replicates, 1999 used, 1 divergent replicate discarded |
| Branch / base commit | `obv/burst11-playkit-chess-first-rating` @ d016791384c5f9fa18db0ae4aa9193162131a59a |

## Ratings (Elo, anchor chess-paper = 1000)

| Rung | Rating | 95% CI (bootstrap) |
|---|---|---|
| chess-sand (random legal-move baseline) | −3743 * | −3825 to −3620 * |
| chess-paper (deterministic built-in engine) | 1000 | 1000–1000 |
| chess-wood (deterministic built-in engine) | 1361 | 1263–1502 |
| chess-stockfish-sf-250 | 1603 | 1469–1804 |
| chess-stockfish-sf-1k | 2172 | 1970–2464 |
| chess-stockfish-sf-10k | 2809 | 2544–3162 |
| chess-stockfish-sf-100k | 3320 | 3019–3772 |

\* sand scored 0.000 across all 40 games against chess-paper, so its true
maximum-likelihood rating is unbounded below — any finite number overstates
it. The printed value is where the fit's Newton solver's gradient underflows
(≈ −27 logit units below the anchor, inside the fit's ±40 saturation guard);
the interval end-points share the same numerical floor. The data-supported
claim is the ordering: chess-sand loses every game to chess-paper, which is
exactly what the floor rung is for.

Ratings increase strictly along the ladder from chess-paper upward. At 95%
separation, the middle engine rungs separate (chess-stockfish-sf-250 vs
sf-1k, and sf-1k vs sf-10k), while the paper→wood→sf-250 spacing and the
sf-10k→sf-100k step have overlapping intervals — directionally supported,
not separated.

## Pair results

- **sand-vs-paper** — chess-sand vs chess-paper: agent score 0.000 over 40 games (20 per colour); every game terminal (checkmate or draw), none hit the 150-action cap.
- **paper-vs-wood** — chess-wood vs chess-paper: agent score 0.887 over 40 games (20 per colour).
- **wood-vs-sf-250** — chess-wood vs chess-stockfish-sf-250: agent score 0.200 over 40 games (20 per colour).
- **sf-250-vs-sf-1k** — chess-stockfish-sf-250 vs chess-stockfish-sf-1k: agent score 0.037 over 40 games (20 per colour).
- **sf-1k-vs-sf-10k** — chess-stockfish-sf-1k vs chess-stockfish-sf-10k: agent score 0.025 over 40 games (20 per colour).
- **sf-10k-vs-sf-100k** — chess-stockfish-sf-10k vs chess-stockfish-sf-100k: agent score 0.050 over 40 games (20 per colour).
- **skip-paper-vs-sf-1k** — chess-paper vs chess-stockfish-sf-1k: agent score 0.000 over 40 games (20 per colour).

The six pre-existing pairs are byte-identical replays of their committed
results (games are seeded and the engine binaries are pinned), so this refit
changes nothing about them; refitting with sand added moved no carried point
estimate and only re-drew the bootstrap intervals.

## Usage

- `node cli/gauntlet.js rate <trajectory-dirs...>` — rates agents against this
  ladder (rung lookup: `<game.id>-<tier>`; non-chess trajectories are skipped
  and reported per agent).
- `node cli/gauntlet.js leaderboard <dirs...>` — shows the chess rating column
  when `rating/ladder-results.json` is present next to the suite.
- Add a rung without replaying old pairs: `node rating/ladder.js
  --pairs=<new-pair> --merge-from=rating/ladder-results.json`.
- Regenerate both files together: run `rating/ladder.js`, then update this
  document from the new results (numbers above are generated, never edited by
  hand).
