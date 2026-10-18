base: alpha
title: [obvious-fleet] Fix cli/rating/human/assisted review findings (PRs #34, #44, #97, #98, #105)
draft: true
---
fleet-packet: burst17-playkit-review-cli

Sweeps every review finding across the five PRs this thread owns, regenerates the stale absolute-calibration results against the corrected ladder, and leaves the full suite green. Zero paid calls: the only engine work is local Stockfish.

## Fixed (code)

- **rating/elo.js — five fit/bootstrap safeguards** (PR #44):
  - Players with no game path to the anchor now throw `UNIDENTIFIED` before the convergence loop (disconnected balanced pairs with `anchorRating: 0` previously converged instantly and returned ratings for unreachable players).
  - A player or group whose every cross-game is a total sweep now throws `DIVERGENT` with the membership named (balanced results elsewhere kept the gradient small enough to slip past every existing guard while the likelihood still had no finite maximum).
  - `rateAgent`'s point estimate and bootstrap percentiles expand the bisection bracket until it surrounds the solution instead of clipping at ±2400 — the committed ladder reaches 3320.3, so a draw against `chess-stockfish-sf-100k` previously reported the clip as a rating.
  - `bootstrapRatings` redraws a resample that omits an original player (bounded redraws, then counted divergent) instead of pushing `undefined` into that player's samples.
  - RNG state advances between draws inside `rateAgent`'s bootstrap samples — each sample previously drew one game `n` times.
- **rating/absolute.js — games survive a failed fit; refit without replaying** (PR #44): played calibration games are written to the output path *before* the fit; `--merge-from=PATH` refits a saved results file's games against the current ladder with no engine replay. Rungs with no finite rating (swept-only) are excluded loudly and recorded in `meta.excludedSweptOnly` instead of poisoning the whole fit, and the report prints an explicit `excluded` row for them.
- **agents/human.js — stdin ownership** (PR #98): one readline interface per input stream, paused while idle, ownership transferred across sequential episodes; `dispose()` releases the stream. The first episode's interface no longer eats the next episode's piped lines, and `gauntlet play` returns to the shell when the episode ends.
- **community/assisted-agent.js — accounting forwarding** (PR #97): the wrapper forwards a retry-inclusive `quoteWorstCaseUsd` computed on the augmented context the inner agent sees (display truncation applied), so capped concurrent runs reserve the wrapper's up-to-three provider attempts, not one.
- **cli/estimate.js — stdout stays machine-parseable** (PR #34): unknown-price diagnostics and file-write progress go to stderr in every mode; `--json` output parses.
- **studies/human-baseline/report.mjs** (PR #98): a `verifyTrajectory` throw on a parseable-but-malformed recording becomes a per-file failure row — the report lists unverified recordings and continues instead of aborting with a stack trace.
- **studies/assisted-harness/solo/compute-stats.mjs** (PR #97): `secPerCall`/`tokensPerCall` divide by provider attempts (`reply.meta.assisted.attempts`, default 1), not assisted turns.
- **READMEs** (PR #44, #105): the rating README's ladder table shows all six pairs including `wood-vs-sf-250` and `sf-250-vs-sf-1k`; the duplicated integration-test text is removed from `gauntlet/README.md`.

## Already on alpha (verified, no change needed)

- Model agents are created fresh per episode (PR #34, two comments) — now pinned by a test asserting distinct agents across episodes for both `model:` and `community-assisted:` specs.
- `verify.js`/`leaderboard` treat `estimate.json`/`estimate.md` as bundle metadata.
- Declared boolean flags stop `--json` from consuming a positional run directory.
- Engine-optional tests skip when Stockfish/GNU Go are absent (baseline run with no Stockfish: 0 failures, 19 skips).

## Not a bug (verified)

- Assisted-agent display cap (PR #97): validation checks the full `legalActions` list, not the displayed prefix — a legal action beyond the cap is accepted on the first attempt; covered by a test.

## Absolute calibration regenerated (PR #44 finding)

`absolute-results.json` was fitted against pre-referee-fix ladder data. Regenerated on the current ladder with a fresh deterministic replay: 192 Stockfish episodes (6 UCI levels × 2 opponents × 8 per colour, 1000-node budget, Stockfish 17.1).

The regeneration exercised the new machinery end to end: the first fit was refused by the new group-sweep guard (the 12-rung group swept `chess-sand` 0/40), the pre-fit snapshot had already saved all 192 episodes, and `--merge-from` refitted them against the current ladder with no replay — losing nothing. The swept-only exclusion as originally shipped keyed on "appeared in a draw" and over-excluded `sf-elo-1700` (see the post-merge round below); the corrected refit excludes only `chess-sand`.

## Post-merge Greptile round (2026-10-18; PR #117 merged as c70b4d8)

Greptile's post-merge review re-raised three findings on this packet's own new code; all three verified real against the merged tree and are fixed fail-first on the branch (pushed fast-forward `5c318ef..47e1794` — the merge made the old tip an ancestor of alpha). No PR opened for the round; the maintainer opens from compare `alpha...obv/burst17-playkit-review-cli`.

- **agents/human.js — interactive hang on turns 2+** (ea50717): `idleInput()` paused the shared readline at the end of every turn, but the next turn's `startInput()` returned on `if (started)` and never resumed — an interactive human typing their next move once `shared.buffer` was empty waited forever. Piped tests never caught it because a whole piped script flushes into the shared buffer during turn 1. `startInput()` now resumes on every turn (a no-op with more than one subscriber; piped flushes are absorbed by the stream-level buffer by design). Regression test writes move 2 to a PassThrough only after turn 1 resolves — red at pristine (paused interface never flows the late write), green after.
- **rating/absolute.js — swept-only over-exclusion; committed data corrected** (19541d2): the exclusion keyed on "appeared in a game with a fractional score" — a draw test, not a sweep test. The committed file proved it bit: `sf-elo-1700` is 1-31 (one win over chess-wood, no draws) yet all 32 of its games were excluded; the packet's earlier "0/32" note was wrong. Swept-only now means a player scored zero points across ALL their games (all losses → rating −∞) or conceded zero across ALL their games (all wins → +∞) — both information-free for the fit (likelihood factor 1, gradient 0). Predicate extracted to new `rating/absolute-lib.js` with tests for all three cases. Refit from the committed file via `--merge-from` (no engine replay): `sf-elo-1700` rated 888.6, chess-sand stays excluded, chess-wood's point rating unchanged, intervals refreshed, `absolute-results.json` regenerated.
- **rating/absolute.js — `--merge-from` metadata** (47e1794): refits wrote the current command's `levels`/`gamesPerColour` into meta and iterated them for the report, so a refit of a file made with other settings could omit carried levels or label unplayed defaults as total sweeps. merge-from now restores the carried settings (prior meta validated against the actual `levelResults` keys, fallback deriving from the `sf-elo-<n>` rungs) with a loud stdout note; the report loop covers exactly the carried rungs. Settings derivation lives in `rating/absolute-lib.js`.

Corrected ladder (anchored at `chess-paper=1000`), replacing the table in the section above:

| UCI Elo | gauntlet rating | 95% interval |
|---|---|---|
| 1320 | 964.8 | [702.7, 1212.8] |
| 1500 | 1103.6 | [856.8, 1301.6] |
| 1700 | 888.6 | [785.2, 1204.3] |
| 1900 | 1290.2 | [1084.2, 1503.9] |
| 2100 | 1438.0 | [1271.1, 1634.6] |
| 2300 | 1528.1 | [1345.3, 1763.4] |

`meta.excludedSweptOnly` is now `chess-sand` only (40 games). Chess-wood's point rating is unchanged at 1361.1 (beating a −∞-rated player adds no gradient), with a slightly tightened interval [1266.2, 1517.1]. Two consecutive `--merge-from` refits are byte-identical modulo `finishedAt`; a third after the metadata fix is byte-identical to the committed file modulo `finishedAt`/`git`. No pinned sf-elo rows exist in `rating/LADDER-RATINGS.md` or `rating/README.md`, so no doc refresh was needed.

## Verification

- Targeted: rating/elo 18/18 (five added), agents/human 15/15 (two added), community/assisted 15/15 (four added), cli/estimate 3/3 (three added), cli/agents 20/20 (one added) — 71/71.
- Full suite at head 09ac50c: 1081 tests, 1079 pass, 0 fail, 2 skip, exit 0 (Stockfish 17.1 + GNU Go 3.8 installed — the 17 engine tests that skip on a bare box run here).
- Typecheck: exit 0.
- Clean-alpha baseline for comparison: 1066 tests, 1047 pass, 0 fail, 19 skip; typecheck exit 0.
- Zero paid calls; engine work is local Stockfish 17.1 only.

Post-merge round verification (head 47e1794): fail-first confirmed for all three findings; focused human 17/17, absolute-lib 10/10, elo 18/18; full suite with engines 1173 tests / 1171 pass / 0 fail / 2 skip, EXIT=0; typecheck EXIT=0; refit determinism as above; zero paid calls.

Human author: Sam Gu (sgu07966@gmail.com)

## Review-finding dispositions

One row per finding across the five PRs this packet owns, plus the three findings left on this PR. Fixing commits: 51a2225, a83ec55, 09ac50c (packet), then b42e4cf, f5e2b66, 741b701 (this round), reconciled with landed alpha (#114 #115 #116 #118 #119) via merge commit 5c318ef — every disposition below unchanged; the studies-side usage-lib variants were merged so the per-attempt invalidReplyRate numerator (invalidAttempts) now divides by provider attempts alongside PR #115's per-attempt secPerCall/tokensPerCall. Branch head: `5c318ef` — full suite 1162 tests / 1160 pass / 0 fail / 2 skip, typecheck clean, zero paid calls. Post-merge Greptile round adds commits ea50717, 19541d2, 47e1794 (head `47e1794`; suite 1173/1171/0/2).

| Finding | Disposition | Fix | Covering test |
|---|---|---|---|
| [P1: assisted retry quote prices only the first request — retries carry the full previous reply (official.js embeds it) plus rejection feedback](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4304947611) | Fixed | b42e4cf — cap-padded worst-case quote via `maxOutputTokens` | `community/assisted-agent.test.js` pad test (fail-first: 187 vs 827 bytes) + `harness/model-agent.test.js` exposure pin |
| [P1: per-agent pending queue drains the next episode's piped lines on the resume flush race](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4304947617) | Fixed | f5e2b66 — stream-level `shared.buffer` | `agents/human.test.js` cross-episode piped-script test (fail-first: 1 s deadline at 09ac50c) |
| [P2: `invalidReplyRate` numerator is per step while the denominator counts attempts](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4304947614) | Fixed | 741b701 — `meta.assisted.invalidAttempts` + `usage-lib.mjs` | `studies/assisted-harness/solo/usage-lib.test.mjs` (fail-first: expected 2, got 1) |
| [Greptile P1: later human moves hang — `idleInput()` pauses per turn, next `startInput()` never resumes](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4309003143) | Fixed (post-merge round) | ea50717 — resume the shared readline on every turn | `agents/human.test.js` late-write test (fail-first: timeout at pristine 5c318ef); replies r4309121506 |
| [Greptile P1: valid calibration games dropped — draw-based swept-only test excluded sf-elo-1700's 1-31 record](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4309003152) | Fixed (post-merge round) | 19541d2 — zero-points-for or zero-points-against predicate + regenerated `absolute-results.json` | `rating/absolute-lib.test.js` three-case test (fail-first); replies r4309121591 |
| [Greptile P2: refits report the wrong settings — `--merge-from` keeps current `levels`/`gamesPerColour`](https://github.com/SamGu-NRX/playkit.ai/pull/117#discussion_r4309003158) | Fixed (post-merge round) | 47e1794 — restore carried settings, report from carried rungs | `rating/absolute-lib.test.js` settings-derivation tests; replies r4309121670 |
| [elo.js:316 — UNIDENTIFIED verdict when anchor-connected players share a sweep with a disconnected group](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973493) | Fixed | 51a2225 | `rating/elo.test.js` anchor-connectivity test |
| [elo.js:379 — DIVERGENT group-sweep guard can reject a valid fit](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973467) | Fixed | 51a2225 | group-sweep guard tests |
| [elo.js:619 — rating-search bracket ±2400 too narrow for the committed ladder](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973472) | Fixed | 51a2225 | bracket-expansion test (ladder reaches 3320.3) |
| [elo.js:468 — bootstrap accepts samples omitting a player](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973479) | Fixed | 51a2225 | completeness-redraw test |
| [elo.js:675 — rateAgent reuses RNG state across bootstrap draws](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973461) | Fixed | 51a2225 | RNG-advance test |
| [absolute.js:260 — games saved only after fitting; a fit crash loses the sweep](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973499) | Fixed | 51a2225 | save-before-fit + `--merge-from` refit tests |
| [absolute-results.json:30 — stale vs the recalibrated ladder](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973487) | Fixed | 09ac50c — regenerated 192-episode replay; corrected by 19541d2 | swept-only exclusion test; `meta.excludedSweptOnly` recorded |
| [rating README ladder rows stale (wood-vs-sf-1k listed, sf-250 missing)](https://github.com/SamGu-NRX/playkit.ai/pull/44#discussion_r4290973507) | Fixed | 51a2225 | docs — all six pairs listed |
| [assisted-agent.js:166 — wrapper hides the inner quote/retry awareness](https://github.com/SamGu-NRX/playkit.ai/pull/97#discussion_r4299070693) | Fixed | 51a2225 | quote-forwarding test (strengthened by b42e4cf) |
| [compute-stats.mjs:101 — usageOf counts one call per step, not per attempt](https://github.com/SamGu-NRX/playkit.ai/pull/97#discussion_r4299070699) | Fixed | a83ec55 | attempts-denominator test (extended by 741b701) |
| [human.js:136 — each episode's fresh readline steals the piped script](https://github.com/SamGu-NRX/playkit.ai/pull/98#discussion_r4299602811) | Fixed | 51a2225 | ownership-transfer test (extended by f5e2b66) |
| [human.js:136 — readline never closed after the episode](https://github.com/SamGu-NRX/playkit.ai/pull/98#discussion_r4299602820) | Fixed | 51a2225 | dispose-release test |
| [report.mjs:175 — one malformed trajectory aborts the whole report](https://github.com/SamGu-NRX/playkit.ai/pull/98#discussion_r4299602815) | Fixed | a83ec55 | per-file failure-row tests |
| [estimate.js:60 — human-readable note on stdout corrupts `--json`](https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4288651315<br>https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4290984660) | Fixed | 51a2225 — diagnostics moved to stderr | `cli/estimate.test.js` diagnostics tests |
| [gauntlet README.md:239 — duplicated integration-test text](https://github.com/SamGu-NRX/playkit.ai/pull/105#discussion_r4300698987) | Fixed | 51a2225 | docs |
| [model agents shared across episodes (worker pool invokes createForEpisode concurrently)](https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4288651267<br>https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4290984569) | Already fixed on alpha | verified at 1190c16 | pinned by factory test added in 51a2225 |
| [verify.js/leaderboard exclude estimate.json/estimate.md](https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4288651330<br>https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4290984665) | Already fixed on alpha | verified at 1190c16 | — |
| [plan.js — declared boolean flags consume `--json` positional](https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4290984674) | Already fixed on alpha | verified at 1190c16 | — |
| [registry-conformance runs chess-stockfish without a Stockfish binary](https://github.com/SamGu-NRX/playkit.ai/pull/34#discussion_r4290984680) | Already fixed on alpha | verified at 1190c16 — engine-optional skips; baseline run without Stockfish: 0 fail, 19 skip | — |
| [assisted-agent.js:191 — capped display hides legal actions beyond maxLegalActions](https://github.com/SamGu-NRX/playkit.ai/pull/97#discussion_r4299070709) | Not a bug | validation checks the full `ctx.legalActions` list; the cap is presentation only | legality-beyond-cap test added in 51a2225 |

🔗 [Obvious Project](https://app.obvious.ai/p/agent-tools-PQyawTQb) · 🧵 [Obvious Thread](https://app.obvious.ai/p/agent-tools-PQyawTQb?thread=th_P4Fsm24g) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/fix-review-findings-cli-task:todo_DXGJlh3p)
