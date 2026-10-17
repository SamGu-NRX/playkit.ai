# Pre-registration — separation pilot

Written and committed before any instrument episode was run (git history is the
proof: this file is the study's first commit). Base: alpha at
`8084062be4501a414be80bdd699eb1d3aef2607c` (carries #107 tier-audit, #105
bundle-spend-cap, #103 dispose-and-abort). Tier evidence:
`gauntlet/studies/tier-audit/tiers.json` committed at that SHA.

## The question

**Do stronger models score higher on the Gauntlet?** The frontier pilot exists
to answer it. The pilot as written (`journeys/pilot/pilot.sh`, PR #102) runs
`suite build --split public --seeds-per-tier 1` — 76 jobs, one episode per
tier — and PR #101's finding applies: with one episode per tier, every
bootstrap interval equals its point estimate, so no comparison can ever
exclude zero. That pilot cannot separate anything, so its result cannot answer
the project's central question regardless of how the models play. This
pre-registration fixes the analysis **before** any frontier data exists, shows
on scripted players of known strength that the analysis separates them, and
prices the suite options the budget decision is choosing between.

## Comparisons (fixed now)

Six comparisons, all paired by seed:

1. `claude-opus-5-5 vs gpt-6-astra`
2. `claude-opus-5-5 vs gemini-4-argon`
3. `gpt-6-astra vs gemini-4-argon`
4. `claude-opus-5-5 vs random`
5. `gpt-6-astra vs random`
6. `gemini-4-argon vs random`

The `random` arm is the bundled seeded random agent played on the same suite
(same seeds), not a calibration table read — pairing requires episodes.
`random` episodes cost nothing (no API calls).

Model-vs-model pairs are bidirectional by design: the analysis reports the
sign of the difference and its interval; calling the sign "stronger scores
higher" needs a strength ordering supplied at read-out time and is not assumed
here. For the instrument checks below the ordering is known by construction.

## Statistic (fixed now)

For a pair of bundles A and B over one suite:

- Per tier `t`, per public seed `s` present in **both** bundles:
  `d[t,s] = score_A(t,s) − score_B(t,s)`, where `score` is the per-episode
  score `e` as defined by `scoring/score.js` (outcome tiers:
  `outcome.normalized[agentSeat]`; efficiency tiers:
  `solved ? min(cap, (par/agentActions)^2) : 0`), under the profile in play.
- Per-tier paired mean `m[t] = mean_s d[t,s]`.
- Pooled statistic `D = equal-weight mean of m[t] over the tiers the pair
  shares`. Equal weighting keeps tiers with more seeds from dominating the
  verdict; per-tier `m[t]` values are printed so any tier's contribution is
  visible.
- **Bootstrap:** 10,000 resamples; within each tier, resample that tier's
  seeds with replacement (independent per tier, one joint draw per resample),
  recompute `D*`; report the 2.5/97.5 percentile interval. The resampler is
  `core/rng.js` `streamFromSeed('separation-pilot/<comparison-key>')` —
  seeded, so identical bundles always yield byte-identical intervals.
- Seeds missing from either bundle are dropped from that pair (counted and
  printed per tier); a tier with no common seeds drops from the comparison
  (printed). Bundles are verified first: every trajectory in every bundle must
  pass `verifyTrajectory`, or the analysis refuses and exits non-zero.

## Decision rule (fixed now)

A comparison is **SEPARATED** on a profile iff

- the pooled 95% interval excludes zero, **and**
- at least `k = ceil(T/2)` of the `T` shared tiers have `m[t]` with the same
  sign as the pooled `D`.

Otherwise **NOT SEPARATED**. No multiplicity correction across the six
comparisons, three profiles, or two win/lose readings: the pilot is a scoping
instrument, every cell is reported, and the rule is per-comparison. Changing
`k`, the weighting, or the profile pool after seeing data is a deviation and
must be labeled as one.

## Reporting planes (fixed now)

- **Three scoring profiles:** `rhae-v1` (primary), `squared-outcome`,
  `chance-adjusted`. The chance-adjusted plane rescales with the committed
  `scoring/baselines/random-public.json`; a tier it refuses (no/stale baseline
  row) drops from that profile only, and the drop is printed. Decision #36
  (the floor profile) stays open — all three are reported, none published
  alone.
- **Win/lose invalid-reply readings:** on outcome ("win/lose") tiers, whether
  invalid replies count against a score is Sam's open decision, so every
  outcome-tier comparison is reported both ways and never averaged:
  - `raw`: the episode score as scored today (invalid replies do not move a
    win/lose score; they only burn actions and can forfeit).
  - `invalid-adjusted`: `e' = e × (1 − invalidSteps/agentActions)`, where
    `agentActions` counts every attempt (the trajectory's recorded
    `end.agentActions`) and `invalidSteps` is the agent steps the referee
    rejected. `e' = 0` when `agentActions = 0`.
  Efficiency tiers already price invalids into `agentActions`, so the two
  readings coincide there by construction; the split is only reported where it
  can differ (outcome tiers).

## Instrument checks (fixed now, before any run)

The analysis is an instrument; it is validated on scripted players whose
strength ordering is known **by construction**, through the real path —
suites built by `make-suite.mjs`, episodes played by `gauntlet run`, bundles
replay-verified by `gauntlet verify`, verdicts by `analyze.mjs`:

- **I1 (must separate):** `skill:0.25:baseline:<game>:engine` vs
  `skill:0.75:baseline:<game>:engine` on the smallest suite option (Option A,
  below) at its proposed seed count. Expected: SEPARATED on `rhae-v1` with the
  pooled difference positive for the 0.75 arm. The dial is the same instrument
  the tier audit used to certify these tiers as skill-resolving; if the
  analysis cannot tell 0.75 from 0.25 on a tier set whose audit-certified dial
  gaps resolve at these seed counts, the analysis is broken.
- **I2 (must not separate):** two bundles of the **same** stand-in
  (`skill:0.25` vs `skill:0.25`, two independent `gauntlet run` invocations)
  on the same suite and seeds. Expected: NOT SEPARATED — every paired
  difference is exactly 0 (deterministic seeds and agents), so no interval can
  exclude zero. This is the false-positive control.
- I1 must also reproduce the label-swap symmetry: swapping the bundle order
  negates the pooled difference and the interval bounds exactly.

## Suite options (fixed now)

All tiers are drawn from `tiers.json` rows flagged `resolves-at-12-or-fewer`
with no `exploitable-by-*` and no `luck-dominated` flag — the audit's
resolving, non-exploitable set — restricted to tiers where **both** audited
dial gaps (`dial-0` vs `dial-05` and `dial-05` vs `dial-1`) resolve at 80%
power within the tier's public seed availability, so the suite separates skill
in both directions rather than only against the random endpoint. Suites are
built by `make-suite.mjs` from the game registry at current game versions —
never hand-edited.

- **Option A — smallest resolving:** 8 seeds per tier over the tiers whose
  larger dial gap needs ≤ 8 seeds.
- **Option B — larger:** 12 seeds per tier over the tiers whose larger dial
  gap needs ≤ 12 seeds, plus `connect4/forced-win` at its 12 available public
  seeds (its upper gap projects 16 seeds for 80% power — at 12 it is below
  target and is included **disclosed as sub-target** to carry one win/lose
  tier in the suite; its cells are read with that caveat).
- **Option C — the current 1-seed pilot, for contrast:** 76 jobs, one episode
  per tier (18 games). Included to price the status quo and to show, not
  assert, that it cannot separate: with one episode per tier every interval
  equals its point estimate.

Cost: `gauntlet estimate` per option per model
(`anthropic/claude-opus-5-5`, `openai/gpt-6-astra`, `openai-chat/gemini-4-argon`)
at `--reasoning-effort high` (PR #102's choice), priced from the committed
`reports/release/prices.frontier.json`. Options are **presented, not picked**:
Sam's budget and cap are open decisions (#36, the pilot cap, invalid replies,
tic-tac-toe's place, CI for `gauntlet/`, the 2048 helper — all out of scope
here).

## What would falsify the design

- I1 failing to separate ⇒ the analysis (not the tiers) is broken; fix before
  any frontier spend.
- I2 separating ⇒ the decision rule has a false-positive path; fix before any
  frontier spend.
- A frontier comparison coming out SEPARATED on `rhae-v1` but NOT on
  `squared-outcome`/`chance-adjusted` (or vice versa) is a real result to
  report, not a bug — the planes disagree about tail weighting, which is
  exactly what the three-profile report exists to show.
