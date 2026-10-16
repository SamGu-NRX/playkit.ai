# On-ramp versus: rung-gap measurement for tictactoe and connect4

The model-separation study found the two entry games' ladders had no middle:
tic-tac-toe offered a single rung (perfect-opponent) that every studied model
lost instantly, and Connect Four jumped from a near-trivial random opponent
(ladder-1) straight to a depth-4 engine. This burst adds the missing middle
rungs — `random-opponent` and `blunder-opponent` on tic-tac-toe (ranks 1–2),
and `ladder-0` (a depth-2 engine, 16 public seeds) on Connect Four (rank 2) —
and measures whether the resulting ladders resolve an agent's strength.

## What this measures

The deterministic baseline dial from the calibration kit: a seeded random
agent, a greedy agent, and each game's bundled engine baseline, played on
every rung's public seeds and scored by the package's own rules. This is the
skill-free stand-in for a model dial: the skill-dial agents live on the
unmerged skill-dial-versus study branch and their runs need model serving
infrastructure (local GGUF models through llama.cpp or provider API keys),
neither of which exists in the environment where this measurement was taken.
What the dial measures — does the ladder distinguish weaker from stronger
play, rung by rung — is the property the on-ramp tiers were added for.

`rung-gaps.json` is generated from the committed calibration tables by
`rung-gaps.mjs` (adjacent-rung score deltas with pooled-SE separation
verdicts). Regenerate everything with:

```bash
./reproduce.sh
```

## Findings

**Tic-tac-toe (3 rungs) — the ladder resolves as designed.** Every baseline
falls monotonically across random-opponent → blunder-opponent →
perfect-opponent, and five of six adjacent gaps separate at 95%:

| baseline | random-opponent | blunder-opponent | perfect-opponent |
|----------|----------------|------------------|------------------|
| random   | 0.469          | 0.188            | 0.063            |
| greedy   | 0.844          | 0.625            | 0.438            |
| engine   | 0.969          | 0.688            | 0.500            |

The greedy dial separates both new gaps statistically; the random and engine
dials separate the floor gap and leave the blunder→perfect gap within noise.
The old ladder's single chasm (0.469 → 0.063 for random) is now two steps.
The blunder-opponent rung is the intended entry point for models that beat
uniform play but lose to perfect search.

**Connect Four (6 rungs) — the depth-2 rung separates the floor but does not
order cleanly for greedy.** The new `ladder-0` fully separates the random
baseline from the random-opponent floor (0.417 → 0.000, separated) and gives
greedy a resolved step down from it (1.000 → 0.219, separated). But greedy
then rises to 0.500 on the depth-4 rung: for the greedy baseline, depth-2 is
harder than depth-4, an inversion the calibration kit flags as within-noise
(CIs [0.0625, 0.4375] and [0.2500, 0.7500] overlap; the ladder already
carried two pre-existing within-noise inversions before this burst). The
engine dial is flat at 0.83–1.00 across all six rungs — strong baselines
cannot distinguish them.

Reading: the Connect Four ladder orders *search depth*, not empirical
difficulty for shallow heuristic agents. The depth-2 rung still does the job
the on-ramp needs — it gives an agent that beats the random-opponent floor a
real opponent at shallow depth — but difficulty-based claims about it should
lean on the greedy separation from the floor, not on monotonicity.

## Limitations

- Episodes per rung are small (8–16 public seeds), so single-gap verdicts
  carry wide CIs; the separation labels come from the CIs, not from power
  analysis.
- The engine dial saturates on tic-tac-toe's blunder and perfect rungs
  (forced wins and draws), so its resolution below 0.5 is structural.
- Model-dial numbers (skill-dial agents, local GGUF models) are not included;
  this study defines the measurement file and harness so the model runs can
  drop in on the skill-dial-versus branch without redesign.
