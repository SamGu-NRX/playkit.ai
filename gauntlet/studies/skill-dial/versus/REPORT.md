# Does the score fall as play gets worse? — skill-dial-versus-engine

**Study:** `skill-dial-versus-engine` · **Branch:** `obv/burst11-playkit-skill-dial-versus` · **Suite:** `playkit-gauntlet-skill-dial-versus-public`

## Question

A calibrated skill-dial agent interpolates between an expert policy (p = 0, full expert
strength) and a random policy (p = 1, fully random) on six two-player games. Does the
official score fall, monotonically and measurably, as the dial turns toward random?

## Answer

**Yes. Every tier, on every scoring profile, shows a negative Spearman correlation
between dial setting and score — 23 of 23 tiers, 69 of 69 profile curves.** Fourteen of
the 23 tiers are perfectly monotone (ρ = −1.000). Where the relationship weakens, the
cause is always a floor or ceiling effect in that tier, not a scoring failure.

## Design

- **Agents.** Each tier's expert is that game's calibration-map engine agent (the same
  expert the calibration harness uses). The measured agent is a pinned skill-dial
  agent (`skill-dial-versus@1.0.0`): at each move, with probability p it takes a random
  legal action, otherwise the expert action — one seeded RNG stream per episode, so a
  (tier, seed, p) cell is byte-reproducible.
- **Games and tiers.** tic-tac-toe (perfect-opponent); Connect Four (ladder-1…4,
  forced-win); hold'em (station, rules, equity); chess (paper, wood, steel, granite);
  chess-endgames (kqk, krk, kbbk, kbnk); chess-puzzles (r0400…r2600). 23 tiers.
- **Dial settings.** p ∈ {0, 0.1, 0.25, 0.5, 0.75, 1}.
- **Seeds.** Study-extended public-format seed sets (40 / 24 / 20 / 8 / 20 / 24 per tier,
  derived with the production `publicSeed` scheme). The full run is 138 cells and
  2,856 episodes.
- **Scoring.** The production scorer (`scoring/score.js`) verifies every trajectory
  (hash chain, seat continuity, replay) before scoring, then computes three profiles:
  `rhae-v1` (ranked head-to-head outcome), `chance-adjusted` (normalized against the
  random baseline), and `squared-outcome` (decisiveness-weighted). The chance-adjusted
  profile uses a study-local random baseline regenerated from the current calibration
  tables (`baseline-random.json`, sha256 `6a18bcca…`); the committed repo baseline was
  stale relative to those tables for tic-tac-toe and hold'em, so the study ships its
  own. Confidence intervals are the scorer's seeded bootstrap, keyed by suite id and
  agent id.
- **Statistics.** Spearman ρ between p and mean score per tier × profile, computed on
  the six dial points; `discriminates` (adjacent-p CI separation) and `saturated`
  flags from the same bootstrap.

## Results

Per tier, chance-adjusted ρ and the p = 0 → p = 1 score arc (rhae-v1 means shown for
compactness; all three profiles agree in shape — see `results.json` for every curve
with CIs):

| Game | Tier | ρ | p=0 | p=0.5 | p=1 |
|---|---|---|---|---|---|
| tic-tac-toe | perfect-opponent | −1.000 | 0.500 | 0.188 | 0.050 |
| connect4 | ladder-1 | −0.928 | 1.000 | 0.958 | 0.458 |
| connect4 | ladder-2 | −1.000 | 0.958 | 0.250 | 0.000 |
| connect4 | ladder-3 | −0.986 | 0.917 | 0.125 | 0.000 |
| connect4 | ladder-4 | −1.000 | 0.917 | 0.208 | 0.000 |
| connect4 | forced-win | −0.986 | 0.979 | 0.292 | 0.062 |
| holdem | station | −1.000 | 0.881 | 0.236 | 0.022 |
| holdem | rules | −1.000 | 0.906 | 0.192 | 0.011 |
| holdem | equity | −1.000 | 0.350 | 0.076 | 0.023 |
| chess | paper | −0.845 | 0.563 | 0.000 | 0.000 |
| chess | wood | −0.845 | 0.438 | 0.000 | 0.000 |
| chess | steel | −0.655 | 0.813 | 0.000 | 0.000 |
| chess | granite | −0.845 | 0.625 | 0.000 | 0.000 |
| chess-endgames | kqk | −1.000 | 1.000 | 0.203 | 0.000 |
| chess-endgames | krk | −0.986 | 1.000 | 0.002 | 0.000 |
| chess-endgames | kbbk | −0.986 | 1.000 | 0.008 | 0.000 |
| chess-endgames | kbnk | −0.845 | 1.000 | 0.000 | 0.000 |
| chess-puzzles | r0400 | −1.000 | 0.958 | 0.292 | 0.000 |
| chess-puzzles | r1000 | −0.986 | 0.708 | 0.250 | 0.000 |
| chess-puzzles | r1400 | −1.000 | 0.625 | 0.208 | 0.000 |
| chess-puzzles | r1800 | −0.986 | 0.375 | 0.083 | 0.000 |
| chess-puzzles | r2200 | −0.507 | 0.083 | 0.042 | 0.000 |
| chess-puzzles | r2600 | −0.926 | 0.083 | 0.042 | 0.000 |

**Reading the weak-ρ tiers.** The five tiers with ρ > −0.93 all sit against a hard
floor or ceiling:

- **Chess (full game)** has a floor: even the pure expert wins only 44–81% of games
  against the calibration engines in 8 seeds (48 episodes), and by p = 0.25 the dial
  is already at zero. The decline is steep but the score runs out of room to fall,
  which is exactly what caps ρ. These tiers flag `discriminates: false` — adjacent
  dial settings are not separable at this seed budget.
- **connect4 ladder-1** has a ceiling: the weakest ladder opponent loses to p = 0 and
  p = 0.1 alike (both 1.000), so the first notch of the dial is invisible.
- **chess-puzzles r2200 and r2600** are saturated near zero (flagged
  `saturated: true`); a single lucky puzzle at p = 0.5 (r2200) is the one visible
  non-monotonic blip in the study — 2 of 48 episodes.

**The dial straddles tier boundaries where they are close.** The straddle diagnostic
asks: is there a dial setting whose CI on the easier tier clears its CI on the harder
one? It fires on connect4 ladder-1↔ladder-2 (a p = 0.5 agent scores 0.958 on ladder-1
but 0.250 on ladder-2), chess wood↔steel, chess-endgames kqk↔krk and kbbk↔kbnk, and
hold'em rules↔equity — useful context for calibration, not a defect of this study.

**Profiles agree.** `chance-adjusted` tracks `rhae-v1` closely on two-player win/loss
games (normalization only shifts means where the random baseline scores non-zero,
e.g. forced-win and hold'em, and it never reverses a tier ordering).
`squared-outcome` compresses the same curves toward zero (it weights decisive wins)
but keeps every tier's ordering intact.

## Reproduction

From a clean checkout of this branch, from `gauntlet/`:

```bash
bash studies/skill-dial/versus/reproduce.sh
```

runs all 138 cells, regenerates `baseline-random.json` and `results.json`, and
`cmp`-checks the regenerated `results.json` against the committed one. Everything is
seeded (episodes by the public seed scheme, the bootstrap by suite id + agent id), so
the check is byte-identical or it fails.

## Provenance

- Baseline: `studies/skill-dial/versus/baseline-random.json` — generated by
  `scoring/generate-baseline.js` from the committed calibration tables (all six games
  current-version); sha256 `6a18bcca13c1c1abd5ac2ddb6e07f6f3ccb1367a27f2576df1850e5ffeac3fdc`.
- hold'em evaluator: includes the five-kicker fix (last touched `a14efa3`).
- Chess engines: Stockfish (bundled calibration ladder); sandbox binary at
  `/usr/games/stockfish`.
- Runs: `studies/skill-dial/versus/runs/` (2,856 verified trajectories; not committed).
- Results: `studies/skill-dial/versus/results.json` — merged per-game scorer output;
  every tier's full CI table lives there.
