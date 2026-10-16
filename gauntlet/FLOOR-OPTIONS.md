# Scoring floor options — the random baseline, and what to do about it

**Decision needed from Sam:** keep scoring outcome tiers raw (`rhae-v1`), or adopt one of the two
flooring profiles as the published aggregate. All three are now selectable; nothing changes unless
we choose.

## The problem, in one line

On outcome tiers, an agent that plays legal-but-random moves scores far above 0 — up to 0.66 of the
maximum on Minesweeper beginner and 0.45 on Hold'em rules — so raw scores overstate how much skill a
score actually represents, and cross-game aggregates are dominated by the games where luck scores high.

Random-baseline means per outcome tier, from the committed calibration tables
(`calibration/tables/*.json`, 20 episodes per tier; `scoring/baselines/random-public.json` carries
the machine-readable copy with per-table SHA-256s):

| Game | Tier | Random r | Greedy | Engine | Engine under `chance-adjusted` | Engine under `squared-outcome` |
|---|---|---|---|---|---|---|
| Minesweeper | beginner | **0.6625** | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Minesweeper | intermediate | **0.3535** | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Minesweeper | expert | **0.1351** | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Minesweeper | torus | **0.4122** | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Hold'em | rules | **0.4498** | 0.3732 | 0.7308 | 0.5107 | 0.5341 |
| Hold'em | station | 0.0193 | 0.6693 | 0.8689 | 0.8663 | 0.7550 |
| Hold'em | equity | 0.0108 | 0.1709 | 0.3179 | 0.3104 | 0.1011 |
| 2048 | t256 | **0.3840** | 0.7979 | 1.0000 | 1.0000 | 1.0000 |
| 2048 | t512 | 0.2342 | 0.4117 | 0.9684 | 0.9587 | 0.9378 |
| 2048 | t1024 | 0.1906 | 0.2578 | 1.0000 | 1.0000 | 1.0000 |
| 2048 | t2048 | 0.1250 | 0.2077 | 0.7744 | 0.7422 | 0.5997 |
| Connect Four | ladder-1 | **0.4167** | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| Connect Four | ladder-2 | 0.0000 | 0.5000 | 0.9167 | 0.9167 | 0.8403 |
| Connect Four | ladder-3 | 0.0000 | 0.2917 | 0.8333 | 0.8333 | 0.6944 |
| Connect Four | ladder-4 | 0.0000 | 0.3750 | 0.8750 | 0.8750 | 0.7656 |
| Connect Four | forced-win | 0.0417 | 0.4167 | 1.0000 | 1.0000 | 1.0000 |
| Chess | paper–granite | 0.0000 | 0.0000–0.1000 | n/a¹ | n/a¹ | n/a¹ |
| Tic-tac-toe (smoke) | perfect-opponent | 0.0625 | 0.4375 | 0.5000 | 0.4667 | 0.2500 |

¹ The chess calibration worker hit the wall-time cap before any engine episodes ran, so the table has
random and greedy only. Chess already floors naturally — a lost game scores 0.0000 — and greedy paper
manages only 0.1000, so chess is the least affected by this problem and the least informative about it.

Efficiency tiers (Mastermind, Sliding, Sokoban) are excluded: they already floor at 0 (score is
`(par/moves)²`, truncation is 0), so no profile changes them — `chance-adjusted` leaves them untouched
by construction and the baseline file records them only for provenance.

## The three options

All three are implemented as selectable scoring profiles; `rhae-v1` stays the default and its output
is byte-identical to the current scorer (pinned by a fixture test).

**A. `rhae-v1` (status quo).** Raw outcome scores. What you keep: published numbers stay comparable
with everything scored so far, and the score keeps its direct meaning ("fraction of the maximum").
What you pay: the aggregate keeps crediting random play with a third to two thirds of the maximum on
the luck-heavy games, and comparisons across games mix scales that don't agree.

**B. `chance-adjusted`.** Score becomes `(e − r) / (1 − r)` with `e` the episode score and `r` the
calibrated random mean for that tier, clamped at 0. Random play scores exactly 0 on every tier;
Minesweeper expert's generous r of 0.135 barely moves anyone. What you keep: one scale where 0 means
"no better than chance" and 1 means "perfect" across all outcome tiers — the only profile under which
a straight cross-game average means something. What you pay: it depends on the calibration tables
(version-checked, so stale tables refuse loudly rather than mis-score) and it discards how far below
chance an agent performs — Hold'em rules greedy scores 0.3732 against an r of 0.4498, worse than
random, and the clamp flattens that to the same 0 as an agent that merely ties chance. If "can lose
to random on purpose" is ever a signal we care about, this profile hides it.

**C. `squared-outcome`.** Score becomes e². No calibration dependency, punishes mediocre play (the
Hold'em equity engine's 0.3179 drops to 0.1011). What you pay: it is amplification, not flooring —
random play still scores r² (0.44 on Minesweeper beginner), so the actual problem is untouched, and
mid-tier results get harder to read. It answers "was this run excellent?" but not "was it better than
luck?".

## The recommendation, priced

Adopt **`chance-adjusted` for the cross-game aggregate and any published leaderboard claim**; keep
`rhae-v1` as the default export for raw-tier comparison and existing-score continuity. Squared is
kept selectable but is not the answer to this question — it amplifies without flooring.

The trade: chance-adjusted makes every published number a function of the calibration tables. That
dependency is the cost that would reverse the call — if the recalibration threads retune the tables
frequently, the published scale shifts with each recalibration, and at that point a fixed floor
(squared) or no floor (rhae-v1) becomes the more stable choice. The version check in
`scoring/baselines.js` makes drift loud, not silent, which is the mitigation.

## What is already in place

- `gauntlet/scoring/profiles.js` — profile resolution, the transforms, named refusals
  (`profile-unknown`, `profile-baseline-required`, `chance-baseline-degenerate` for r ≥ 1 − 1e-3).
- `gauntlet/scoring/baselines.js` — baseline validation and SHA-256 file loading.
- `gauntlet/scoring/generate-baseline.js` — regenerates `baselines/random-public.json` from the
  calibration tables, byte-deterministically, recording every source table's hash.
- `score.js` / `leaderboard.js` — per-entry and board-level profile options; non-default boards
  carry a `scoring` block naming the profile and baseline hash; entries scored under different
  profiles refuse to be ranked together.
- `scoring/profiles.test.js` — 20 tests: hand-computed formula checks, the byte-identity fixture,
  every refusal by name, and the committed baseline against the tables.
