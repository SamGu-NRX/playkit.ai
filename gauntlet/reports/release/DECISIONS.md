# Decisions carried into the release board — updated for the final tree

Three decisions Sam left open at board-v2, revisited against the final tree
(`obv/burst8-playkit-integration-3` at `a5ab54e`), the six review fixes it
absorbed, and the release measurements. Decisions are **presented, not made**:
each names what each option buys, what it costs, and what evidence would tip it.

---

## Decision 1 — holdem's engine baseline strength

**The decision on the table (board-v2's DECISIONS.md, carried forward):** the
holdem `engine` baseline plays a fixed-strength internal policy, and the ladder
tiers (`station`, `rules`, `equity`) were calibrated against it. Choice: keep
the current engine strength as the tier anchor, or strengthen it and re-rank
the tiers.

**What the final tree adds:** holdem is now v1.2.0 on the final tree
(calibration/tables/holdem.json regenerated at 1.2.0, 12 calibration episodes
per tier, no failures), and the release board re-played all six holdem baseline
episodes fresh (3 greedy + 3 engine, deterministic, replay-verified). The tier
ladder — station → rules → equity, outcome-scored — is structurally unchanged
from board-v2's tables, so the decision is unchanged in substance.

**Options:**

- **Keep the current engine as anchor (status quo).** Buys: comparability with
  board-v2's numbers and every downstream report that cites them; zero new
  work. Costs: if the engine is weak relative to competent play, the `equity`
  tier overstates a model's holdem ability — a model can clear `equity` by
  exploiting a beatable opponent rather than by playing well.
- **Strengthen the engine, re-rank the tiers.** Buys: a holdem ladder that
  measures poker play rather than opponent exploitation; the tier names would
  mean what they claim. Costs: breaks trajectory continuity — every holdem
  trajectory on every board becomes a stale-version artifact that cannot be
  re-verified on the new tier definitions; board-v2's holdem columns (and the
  release board's) would need a full re-play and re-rank, and cross-board
  comparisons break.
- **Keep the anchor, publish the engine's measured record alongside the tier.**
  Buys: the reader can see how strong the anchor actually is (the release board
  publishes the engine baseline's own holdem score next to the models'), which
  is the information a re-rank would act on, at zero calibration cost. Costs:
  the decision is deferred, not resolved; the tier names remain aspirational
  until someone acts on the published record.

**What would tip it:** a future model clearing all three holdem tiers while
playing demonstrably weak poker (measurable once a strong-model run exists).

---

## Decision 2 — cross-model cost-estimator honesty

**The decision on the table (board-v2's DECISIONS.md):** the cost estimator's
"low" call counts are extrapolated from engine/greedy baseline episodes, but
models do not play like engines — board-v2 measured per-game call ratios
spaning 0.06x-15.97x against the low basis. Choice: publish the estimator's
low/high bracket as-is (clearly labeled estimates), or build a model-conditioned
estimator before the next board.

**What the final tree adds (release measurements):** the release board re-ran
the estimator on the final-tree suite and the projection tool again against
measured qwen usage — same method as board-v2, refreshed inputs (see
`projection-frontier-full.md` and `usage-qwen.json` in this directory). The
structural gap is unchanged: an engine's call count is a floor for any model
that survives longer in engine-opponent games, and the estimator has no basis
at all for the four games it marks `basis: none` (2048, chess-puzzles,
mastermind, minesweeper) — its USD columns there are null and only the measured
column covers them.

**Options:**

- **Publish the labeled bracket (status quo).** Buys: honest, cheap, already
  done — the bracket plus the measured-qwen column brackets reality from both
  sides, and every number carries its method line. Costs: the low column stays
  uninformative per-model; a reader who wants "what would GPT-6 Astra cost on
  holdem" gets a range wider than the answer.
- **Model-conditioned estimator.** Buys: per-model call-count prediction from
  measured usage on the pilot, which is exactly the median-ratio correction the
  projection tool already computes — formalized. Costs: it is a model fitted to
  one model's behavior (qwen 1.5B, temp 0); stronger models survive longer and
  weak models forfeit earlier, so the "correction" is a transfer assumption, not
  a measurement. The honest version needs at least one more model's measured
  usage to validate against, which is a full new pilot run.
- **Publish measured-usage-based projections only, drop the low/high bracket
  from the board.** Buys: the board stops showing a column (floor) that is
  systematically wrong in a known direction. Costs: the bracket is the only
  coverage for games the measured run cannot extrapolate to at other seed
  counts, and the budget-cap column (a weak model burning max actions
  everywhere) has no measured replacement.

**What would tip it:** a second measured model run — with two models of
measured usage, a model-conditioned estimator becomes testable rather than
assumed.

---

## Decision 3 — invalid replies on efficiency tiers

**The decision on the table (as stated):** invalid replies currently burn
action budget but do not count against efficiency scores, while ARC-AGI-3
counts every action. Give each agent's invalid-reply count on efficiency tiers
and what each option would change.

**Premise check against the final tree — the premise is only half true.**
Measured on the merged tree:

- *Burn budget:* yes. `core/runner.js` increments `agentActions` for invalid
  attempts (lines 343-346) and ends the episode `forfeit-invalid` after three
  consecutive invalid replies; budget exhaustion ends `budget-exhausted`,
  which is unsolved (score 0).
- *Efficiency scores:* **invalid replies already count against them.**
  `scoring/score.js` computes the efficiency episode score as
  `e = min(cap, (par / end.agentActions)^2)` (episodeScore), and
  `end.agentActions` includes invalid attempts — the score.js header says so
  explicitly ("agentActions counts every attempt including invalid ones"), and
  the runner increments both counters on an invalid attempt. What does *not*
  count them is the **game-side** `outcome.normalized` (PR #24's review pinned
  that: `normalized[0] = 1` despite interleaved invalids; "nothing recomputes
  normalized from total attempts") — but efficiency tiers never read
  `outcome.normalized`; they read `par` vs `end.agentActions`.

So on the final tree the gauntlet already behaves ARC-AGI-3-ward: every action,
valid or not, is inside the efficiency denominator. The live choice is the
opposite direction from the one the premise implies.

**Measured invalid-reply counts on efficiency tiers (this release, verified
trajectories — `release-stats.json` and `usage-qwen.json` in this directory).**
Baselines emit zero invalid replies (deterministic agents). The qwen 1.5B run's
per-game invalid counts on the efficiency games:

| game | calls | invalid | rate | episode endings |
|---|---:|---:|---:|---|
| cube | 105 | 0 | 0.0% | 3× budget-exhausted |
| sokoban | 575 | 38 | 6.6% | 3× budget-exhausted |
| sliding | 93 | 35 | 37.6% | 4× forfeit-invalid |
| mastermind | 16 | 10 | 62.5% | 3× forfeit-invalid |

(2048's t256 tier is outcome-scored; its efficiency tiers saw 2 invalids in
654 calls, 0.3%, all four episodes reaching terminal.) The measured pattern
backs the forfeit side of the tip condition: on sliding and mastermind the
invalid rate is high enough that every episode ends `forfeit-invalid` — the
model loses the episode outright rather than dragging a solved denominator —
while cube/sokoban show zero-to-low invalids with budget-exhausted endings.
No efficiency episode was solved by the model this release, so the
"denominator drag on solved episodes" case has no data yet; what the numbers
do show is the double-punishment the status-quo option names (forfeit plus
denominator) concentrated in the two games with the worst format compliance.

**Options:**

- **Status quo (invalids count in the efficiency denominator).** Buys: ARC-AGI-3
  alignment; a model that rambles pays in the score, not just in budget; no
  recalibration. Costs: a model with a high invalid rate is double-punished —
  it forfeits episodes outright (3 consecutive) and drags the denominator on
  episodes it does solve — so efficiency scores partially measure format
  compliance, not play quality.
- **Valid-turns-only denominator (`par / validTurns`).** Buys: efficiency
  measures play quality independent of format compliance; forfeits still cost
  the episode, so rambling is not free. Costs: a runner/scorer change
  (`end.validActions` is not currently recorded — the runner would need to
  expose it), a recalibration note on every efficiency tier, and historical
  comparability breaks: the same trajectory scores differently before and
  after. It also diverges from ARC-AGI-3's every-action-counts rule.
- **Publish invalid rate next to every efficiency score (no scoring change).**
  Buys: the double-punishment becomes visible instead of hidden — a reader can
  discount a score that was dragged by forfeits — at zero recalibration cost.
  Costs: the score itself still mixes play quality with format compliance; the
  reader does the separation.

**What would tip it:** a model that solves efficiency tiers with a high invalid
rate — if forfeits (not denominator drag) are the dominant penalty, the case
for the valid-turns option strengthens; if solved episodes' denominators barely
move, the status quo is fine and the published rate settles it.

*Correction note:* board-v2's DECISIONS said "no game or scoring code counts
invalid replies against efficiency scores." That holds for the game-side
normalized outcome, not for the scoring layer's efficiency formula; the
distinction is pinned here with file and line references so the next reader
does not have to re-derive it.
