# PR.md — burst11-playkit-chess-first-rating

Branch `obv/burst11-playkit-chess-first-rating` → `alpha` (base d016791). Draft for human review; never merged autonomously.

Human author: Sam Gu (sgu07966@gmail.com)

## Summary

Three deliverables, one theme: make the chess tier ladder *start* somewhere winnable, and make every number behind it current and honest.

1. **chess v1.2.0 — new `sand` tier (rank 1).** A seeded uniform random legal-move opponent below `paper`. Five public seeds; ranks paper→granite shift to 2–5. `createRandomBaselineAgent` in `games/chess/baselines.js` backs it; tier suite construction and the estimator needed no changes (tier metadata + the generic `game.opponent` dispatch cover sand).

2. **SAN-shaped illegal moves now diagnose as illegal, not unparseable.** `"e5"` is well-formed SAN; if `chess.move()` rejects it, the parser now returns `move "e5" is not legal in the current position` instead of the catch-all `cannot parse ... as UCI ... or SAN ...` diagnostic. Malformed strings keep the cannot-parse message. No accepted move expands.

3. **Rating ladder brought to v1.2.0 without replaying history.** `rating/ladder.js` gains `--pairs=` filtering and `--merge-from=`; the fresh `sand-vs-paper` pair (40 colour-symmetric games) merged onto the six committed pairs, refitting 280 games.

## Results (verified this session, on this sandbox)

**Ladder (280 games, anchor chess-paper = 1000):**

| Rung | Rating | 95% CI |
|---|---|---|
| sand | −3743 * | unbounded below * |
| paper | 1000 | (anchor) |
| wood | 1360.9 | 1263–1502 |
| sf-250 | 1603.0 | 1469–1804 |
| sf-1k | 2172.4 | 1970–2464 |
| sf-10k | 2808.8 | 2544–3162 |
| sf-100k | 3320.3 | 3019–3772 |

\* sand scored **0/40** against paper — its true MLE is unbounded below; the printed value is where the fit's Newton gradient underflows (≈ −27 logit units below the anchor, inside the fit's ±40 saturation guard). The data-supported claim is the ordering: sand loses every game to paper, which is what a floor rung is for. `LADDER-RATINGS.md` states this verbatim.

The six carried pairs are byte-identical replays of their committed games (seeded, pinned engine); carried point estimates did not move — only the bootstrap intervals re-drew.

**Calibration (chess-only regen, 75 episodes, 426.8s):** five tiers, **0 violations**, one within-noise warning (greedy 0.7 [0.5, 0.9] < random 0.8 [0.6, 1] on sand at 5 seeds — intervals overlap, framed as within-noise by `calibration/checks.js` itself). `REPORT.md`'s chess section spliced to v1.2.0 with a chess-only-regen note; the other twelve game sections are untouched.

**Forfeit study (`studies/chess-first-rating/`):** all 49 invalid replies across the 12 committed Qwen episodes re-judged — 35 illegal moves, 14 SAN-shaped pawn pushes, 20 stale repeats, 0 parser faults; legal moves were listed at all 49 invalid steps. `forfeits.md` documents the v1.2.0 diagnostic change for those 14 rows. Version status: the 4 committed `chess` trajectories fail current verification purely on their v1.0.0 stamps (notation/render unchanged); `chess-stockfish` verifies 4/4.

## Verification

- chess packet suite 31/31 (sand reproducibility, legal-reply, full-episode-vs-greedy tests; parser diagnostic tests incl. malformed-strings-still-cannot-parse); typecheck clean.
- Full gauntlet suite: 621 tests — 618 pass, 2 skip (Stockfish env skips), 1 fail = the e2e rating-column assertion, which pinned the v1.1.0 ladder-known episode count (2); sand is now a rated rung, so the count is 3. Assertion and comment updated; the file reruns 4/4 solo.
- `GAUNTLET_STOCKFISH` unset for suite runs (known env sensitivity in `engines/uci/client.test.js`).

## Files

- `games/chess/index.js` (spec 1.2.0, sand tier, dispatch), `games/chess/baselines.js` (random baseline agent), `games/chess/notation.js` (diagnostic)
- `rating/ladder.js` (`--pairs`, `--merge-from`), `rating/ladder-results.json`, `rating/LADDER-RATINGS.md`, `rating/README.md`
- `calibration/tables/chess.json`, `calibration/REPORT.md` (chess section)
- `studies/chess-first-rating/` (classifier, forfeits.json/md, tools)
- `test/integration/cli-rate-e2e.test.js` (ladder-known rating count 2 → 3 for the five-rung v1.2.0 ladder)
- `gauntlet/README.md` (43 tiers / 569 public seeds), tests

🔗 [Obvious Project](https://app.obvious.ai/p/agent-tools-PQyawTQb) · 🧵 [Obvious Thread](https://app.obvious.ai/p/agent-tools-PQyawTQb?thread=th_dnBM6e2t) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/gauntlet-the-first-language-model-to-finish-chess-task:todo_PxMx4l8j)
