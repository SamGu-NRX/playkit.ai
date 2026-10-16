# model-separation-v2/versus — do real local models land above random, and in size order, on the two-player on-ramp tiers?

**Answer: NO on both counts.** On the one clearly-discriminating tier (connect4/ladder-1) every model lands well above random, but the **smallest** model scored highest (0.917 vs 0.75/0.75); pooled means are statistically indistinguishable (0.31–0.34, overlapping CIs, `sizeOrderMonotone: false`, pooled Spearman −0.5). This echoes the wave-8 solo study (no above-random separation, no size order) but adds the first clean counter-signal: a tier where smaller-is-better, driven by the 0.5B's aggressive play style rather than competence.

- **Branch:** `obv/burst12-playkit-separation-v2-versus` (base `alpha`)
- **Suite manifest:** 4 tiers × 12 public seeds × 3 models = 144 episodes, 0 errors, all bundles manifest+provenance verified by `full-run.sh` before `MODEL-COMPLETE` (each model's `run.json` carries the verified sha256)
- **Scoring:** production profiles (raw outcome / chance-adjusted / squared-outcome); every model scored as one per-model suite containing both games (the design that fixes the tictactoe-only suite refusal); an independent per-episode mirror recomputes every score — mirror agrees everywhere (`profile-results: 12 groups (12 scored), episodes: 144 (0 errors); mirror agrees everywhere`)
- **Reproduce:** `bash reproduce.sh` (rebuilds suite from registry, re-runs, re-scores, byte-compares stats)

## Per-tier results (raw outcome profile, 12 episodes/model/tier)

| tier | random | 0.5B | 1.5B | 7B | Spearman (size↔score) | monotone |
|---|---|---|---|---|---|---|
| tictactoe/random-opponent | 0.469 | 0.375 [0.125, 0.625] | 0.292 [0.083, 0.542] | 0.292 [0.083, 0.542] | −0.625 | no |
| tictactoe/blunder-opponent | 0.188 | 0.083 [0.000, 0.250] | 0.208 [0.000, 0.458] | 0.292 [0.083, 0.542] | +1.0 | yes |
| connect4/ladder-1 | 0.417 | **0.917** [0.750, 1.000] | 0.750 [0.500, 1.000] | 0.750 [0.500, 1.000] | −0.625 | no |
| connect4/ladder-0 | 0.000 | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | — | no |
| **pooled** | | 0.344 [0.219, 0.479] | 0.313 [0.188, 0.448] | 0.333 [0.208, 0.469] | **−0.5** | **no** |

## Findings

1. **No size ordering — and the one discriminating tier is inverted.** connect4/ladder-1 is the only tier whose CIs clear the random mean decisively. There the 0.5B leads (0.917; CI floor 0.750 > random mean 0.417) while both larger models sit at 0.750. The only size-monotone tier is tictactoe/blunder-opponent, where all models are within noise of random. The connect4/ladder-1 inversion is consistent with the 0.5B's higher invalid rate *buying* favorable positions rather than skill — see finding 3.
2. **Above-random is tier-conditional, matching the solo study.** On tictactoe/random-opponent all three models are *below* random (0.29–0.38 vs 0.469). On connect4/ladder-0 nobody — random included — scores above 0, so it cannot discriminate (the solo study's zero-floor pattern, repeated).
3. **The 0.5B wins despite forfeiting ~6–43% of calls to invalid output** (`invalidRate` 0.38 / 0.43 / 0.06 / 0.41 across tiers; 1.5B and 7B are 0.00 everywhere). Its tictactoe losses track the invalid forfeits; its ladder-1 win survives the 6% forfeits. Smaller-model invalid output was the solo study's discriminator; here it is visible but does not produce a clean separation because the 0.5B still won the decisive tier.
4. **Latency (sec/call) is contaminated for the 7B.** The sandbox froze repeatedly mid-run (three freeze windows; the 7B pass spanned all of them, wall 9115 s). Frozen wall inflates per-call wall time for any episode spanning a freeze: 7B shows 73.9 s/call on random-opponent and 84.1 on ladder-1, versus **1.47 s/call on blunder-opponent, measured entirely inside one live window** (probe-era: 2.54 s/call). Treat 7B sec/call except the blunder-opponent value as infrastructure noise, not measurement. 1.5B (0.36–7.05) and 0.5B (0.20–9.86) were unaffected except where noted.
5. **Tokens/call is uniform across sizes.** All three models emit the same volume per call (tictactoe ~320–330 tokens/call; connect4 ~444–450) with no size-specific padding gradient in this run — the output-padding behavior flagged in the solo study appears as a shared property here, and the pooled token metric does not discriminate. (Per-model per-tier `tokensPerCall` is in `stats.json`.)

## Verdict vs the solo study

| question | solo (wave-8) | versus (this study) |
|---|---|---|
| above random on every tier | no (zero floors) | no (tictactoe/random below random; ladder-0 zero floor) |
| size order anywhere | directional only, CIs span zero | one tier monotone (within noise); pooled **not** monotone |
| decisive discriminator | sec/call, invalid rates | ladder-1 score **inverted** + invalid rates |

**Same answer, sharper evidence.** More parameters did not buy rank on the two-player on-ramp; the 0.5B's willingness to move (even wrongly, even invalidly) beats deliberation on connect4/ladder-1.

## Caveats

- 7B sec/call values are freeze-contaminated except blunder-opponent (see finding 4). Scores, seeds, invalid rates, and tokens are unaffected: calls are timestamped, scoring depends only on trajectory content, and all bundles passed in-script verification (`verdict ok`).
- 12 seeds/tier is the largest uniform count available (connect4/ladder-1 exposes exactly 12 public seeds). CIs are wide; every "no ordering" conclusion is a noise statement, and the study is designed so `reproduce.sh` can re-verify byte-for-byte.
- 7B part-1 has no listed hash in `models.sha256` (documented limitation carried from the solo study; part-2, 0.5B, and 1.5B verified exactly).

## Reproduction

```bash
cd studies/model-separation-v2/versus
bash reproduce.sh          # suite rebuild → runs → score → byte-compare stats.json
node --test study.test.mjs # 8/8
python3 compute-stats.py   # regenerates stats.json (self-test: python3 compute-stats.py --self-test)
```
