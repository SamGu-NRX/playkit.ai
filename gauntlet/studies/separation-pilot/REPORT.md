# Separation pilot — report

Study: `gauntlet/studies/separation-pilot` · branch `obv/burst15-playkit-separation-pilot` · base alpha `8084062`

fleet-packet: burst15-playkit-separation-pilot

## The question

**Do stronger models score higher on the Gauntlet?** The pilot as written
(`journeys/pilot/pilot.sh`, PR #102) runs one episode per tier — and PR #101's
finding applies: with one episode per tier, every bootstrap interval equals its
point estimate, so no comparison can ever exclude zero. That pilot cannot
separate anything, so its result cannot answer the project's central question
regardless of how the models play.

This packet fixes the analysis **before** any frontier data exists
(`PREREGISTRATION.md`, committed before any instrument episode ran), validates
it on scripted players of known strength through the real path, and prices the
suite options the budget decision is choosing between. **Options are presented,
not picked** — budget and cap are open decisions (#36).

## What was built

| Piece | Commit | What it is |
|---|---|---|
| `PREREGISTRATION.md` | 45cd710 | Six paired-by-seed comparisons, decision rule, profile set, invalid-reply readings, instrument checks, suite options — fixed before any episode |
| `make-suite.mjs` | 45cd710 | Builds suite options from the committed tier audit + current game registry; refuses version mismatches; never hand-edited |
| `analyze.mjs` | d91e382, 0a21cbf, 1c1fb14 | Applies the decision rule to `gauntlet run` bundles; replay-verifies every trajectory and mirrors `scoring/score.js` per game before any verdict prints; byte-deterministic output |
| `instrument.sh` | d91e382, 0a21cbf | Runs the preregistered instrument checks end to end (dial arms → composite bundles → analysis → assertions); ~10 min, deterministic |

## Instrument validation — all checks PASS

The analysis is an instrument; it was validated on scripted players whose
strength ordering is known **by construction** — the skill dial the tier audit
used to certify these tiers — through the real path: suites built by
`make-suite.mjs`, episodes played by `gauntlet run`, bundles replay-verified by
`analyze.mjs` (which independently re-verifies every trajectory and mirrors the
production scorer before printing any verdict).

| Check | Expected | Result |
|---|---|---|
| **I1** — `skill:0.25` vs `skill:0.75` on the smallest resolving suite (72 episodes/arm) | SEPARATED on `rhae-v1`, D > 0 | **PASS** — D = 0.477429, ci95 = [0.422105, 0.535387], sign agreement 9/9 tiers, **SEPARATED** |
| I1 on `squared-outcome` / `chance-adjusted` | note | **SEPARATED** — D = 0.477429 on both (efficiency-only suite ⇒ profiles coincide; CI wiggle is resampling seed only) |
| **I2** — `skill:0.25` vs itself (two independent runs) | NOT SEPARATED, D = 0 exactly | **PASS** — D = 0, ci95 = [0, 0], **NOT_SEPARATED** |
| **Label-swap symmetry** — `analyze(B, A)` | negates D and the interval bounds **exactly** | **PASS** — D = −0.477429, ci95 = [−0.535387, −0.422105] |
| Determinism | byte-identical output for identical bundles | **PASS** — two full runs `cmp`-identical |

Committed evidence: `outputs/instrument/{I1,I2,I1-swapped}.json`; re-run with
`./instrument.sh` (~10 min, deterministic).

The mirror check earned its place during development: through it the production
`score()` refused the naive composite bundle twice (agent-identity: one dial id
per game; duplicate-episodes: a stale-composite merge bug in `instrument.sh`)
and exposed a reporting-precision trap (tier values are rounded to 6 decimals).
The shipped analyzer mirrors per game at score()'s own precision, refuses
duplicate trajectory keys, and keys the comparison and bootstrap stream by the
**unordered** label pair so the preregistered label-swap symmetry holds exactly.

## Costed pilot suite options

`gauntlet estimate --no-probes --prices reports/release/prices.frontier.json`,
one estimate per option per model. Calls/tokens are model-independent (fitted
from committed small-model runs); USD is where models diverge. Committed:
`outputs/estimates/*.json`.

| Option | Suite | Jobs | Calls (low–high) | Opus 5.5 | GPT-6 Astra | Gemini 4 Argon | **3-model total** |
|---|---|---|---|---|---|---|---|
| **A — smallest resolving** | 3 games, 9 tiers, 8 seeds | 72 | 4,620–10,432 | $8.96–$23.94 | $22.40–$59.84 | $4.48–$11.97 | **$35.84–$95.74** |
| **B — larger** | 5 games, 14 tiers, 12 seeds (connect4/forced-win sub-target, disclosed) | 152 | 7,436–16,108 | $14.16–$32.21 | $35.39–$80.54 | $7.08–$16.11 | **$56.63–$128.86** |
| **C — current 1-seed pilot** | 18 games, 76 tiers, 1 seed | 76 | 2,265–13,884 | $6.78–$43.13 | $16.96–$107.81 | $3.39–$21.56 | **$27.13–$172.50** |

Reading the table:

- **Option C cannot separate anything, at any budget.** One seed per tier makes
  every interval equal its point estimate (PR #101); its high side ($172.50 for
  three models) exceeds Option A's ($95.74) because its eight unfitted games
  run to their maxActions ceilings. It is the status quo, priced here for
  contrast — not a candidate.
- **Option A is the only option whose every tier separates skill in both dial
  directions at ≥80% power within available public seeds**, and it is the
  cheapest at the ceiling.
- **Option B buys two more games and four more tiers**, carries one win/lose
  tier (`connect4/forced-win`, 12 of a projected-16 seeds — disclosed
  sub-target), at ~1.35× A's ceiling.
- **Low sides are floors, not promises.** Games with no fitted call basis are
  excluded from the low side (A: wordle; B: mastermind + wordle; C: 8 games) —
  true lows are higher. Estimates are also reasoning-effort-agnostic (the
  `estimate` command takes no effort flag) while PR #102 runs at high effort —
  real spend can exceed the high side if models think longer than the fitted
  token means.
- Suite manifests: `suite.smallest-8.json` sha256 `7e12cdb3…`,
  `suite.larger-12.json` `9bfc320c…`, `suite.pilot-1seed.json` `d5509eb9…`.

## Running the pilot (once the option is picked)

```
# per arm (six comparisons share four arms: three model arms + free random)
node cli/gauntlet.js run --suite studies/separation-pilot/outputs/suites/suite.smallest-8.json \
  --agent model:anthropic/claude-opus-5-5 --reasoning-effort high \
  --out studies/separation-pilot/outputs/runs/claude-opus-5-5

node cli/gauntlet.js run ... --agent model:openai/gpt-6-astra ...
node cli/gauntlet.js run ... --agent model:openai-chat/gemini-4-argon ...
node cli/gauntlet.js run ... --agent random ...          # $0

# the preregistered analysis (verdicts are data; exits 0 either way)
node studies/separation-pilot/analyze.mjs <bundle> <bundle> [--json]
```

Comparisons 1–3 are model-vs-model; 4–6 are model-vs-random. The analysis
reports D, the seeded percentile 95% interval, per-tier means, and the
SEPARATED/NOT_SEPARATED verdict on all three profiles under both invalid-reply
readings; `PREREGISTRATION.md` ("What would falsify the design") says what each
unexpected outcome means.

## Environment certification

- Pristine alpha base (`8084062`): 1,050 tests — 1,048 pass / 0 fail / 2 skip, exit 0.
- Full suite at the study head (`2eb0116`): 1,050 tests — 1,048 pass / 0 fail / 2 skip, **exit 0**; `npm run typecheck` **exit 0**.

## Out of scope (per preregistration)

Option selection, budget/cap (#36), pilot cap semantics, invalid-reply policy,
tic-tac-toe's place, CI for `gauntlet/`, the 2048 helper.
