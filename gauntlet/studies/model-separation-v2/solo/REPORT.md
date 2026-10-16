# Model-separation-v2 solo study — REPORT

Study: **do real local models land above random, and in size order, on the solo on-ramp tiers?**
Branch: `obv/burst12-playkit-separation-v2-solo` (from `alpha` @ `72e5543`). Base repo `SamGu-NRX/playkit.ai`.

## Method (pinned before any model ran)

- Models: Qwen2.5-Instruct 0.5B / 1.5B / 7B, GGUF Q4_K_M, served by `llama-server` b11662 (`--temp 0.0 --seed 42 --ctx-size 4096`), `--concurrency 1`, `--max-output-tokens 256`, `--call-timeout-ms 60000`.
- Tiers (the six registered solo on-ramp tiers): `sliding/p8-short`, `sokoban/one-box`, `mastermind/mini`, `cube/cube-2`, `nonogram/tiny`, `minesweeper/beginner`; 8 public seeds per tier.
- Agent: `model:openai-chat/<stem>` on the official track through `cli/gauntlet.js`; every bundle `bundle verify`d (manifest hash + all episodes replayed).
- Random floor: calibration tables from `scoring/generate-baseline.js` (rhae-v1 chance-adjusted profile); `nonogram/tiny` has no calibration table on `alpha`, so a study-local random run (`agents/random.js`, 16 seeds, bundle-verified) measured its floor; that entry carries `studyLocal: true` in `baseline-random.json`.
- Scoring: `scoring/score.js` (profile `rhae-v1`): per-tier score vs random, invalid-reply rates, paired-by-seed model differences, Spearman correlations between models. Aggregation in `compute-stats.mjs` (deterministic; no model files needed to re-run — see `reproduce.sh`).
- 7B wall-clock: intended to be measurement-driven — a one-episode measurement pass per tier sets the seed budget, tiers that do not fit the deadline get 4 seeds or are dropped, and the choice is recorded here. The measurement pass itself failed (its `bash -c` subshell lost the script globals, so every measured episode errored instantly and wrote a bogus 0 s timing); adaptation fell back to observed pace: 0.5B and 1.5B ran the full 8 seeds on all six tiers; 7B ran 4 seeds on cube/cube-2, minesweeper/beginner, mastermind/mini, sliding/p8-short, and sokoban/one-box; nonogram/tiny was dropped at the deadline gate (recorded as `not played` in stats.json).

## Results

| Tier | Random mean (source) | qwen2.5-0.5b rhae-v1 (chance-adj) [n] | qwen2.5-1.5b rhae-v1 (chance-adj) [n] | qwen2.5-7b rhae-v1 (chance-adj) [n] |
|---|---|---|---|---|
| sliding/p8-short | 0 (calibration, n=16) | 0 (0) [8] | 0 (0) [8] | 0 (0) [4] |
| sokoban/one-box | 0 (calibration, n=16) | 0 (0) [8] | 0 (0) [8] | 0 (0) [4] |
| mastermind/mini | 0.02985 (calibration, n=25) | 0 (0) [8] | 0 (0) [8] | 0.5 (0.5) [4] |
| cube/cube-2 | 0 (calibration, n=16) | 0 (0) [8] | 0 (0) [8] | 0 (0) [4] |
| nonogram/tiny | 0 (study-local, n=16) | 0 (0) [8] | 0 (0) [8] | not played (see REPORT.md) |
| minesweeper/beginner | 0.6625 (calibration, n=25) | 0.1162 (0.09892) [8] | 0.1919 (0.08848) [8] | 0.3803 (0.177) [4] |

Pooled rhae-v1 episode means (all tiers):
- qwen2.5-0.5b: 0.01937 (95% CI [0, 0.0581], n=48)
- qwen2.5-1.5b: 0.03198 (95% CI [0, 0.08275], n=48)
- qwen2.5-7b: 0.1761 (95% CI [0.03099, 0.3451], n=20)
- mastermind/mini: Spearman(size, mean) = 0.866, monotone-increasing = False
- minesweeper/beginner: Spearman(size, mean) = 1, monotone-increasing = True

## Verdict

## Verdict

**Above random: no.** On the four zero-floor tiers (sliding, sokoban, cube, nonogram) every model scores exactly 0 — a tie with random, not above it. On mastermind the 0.5B and 1.5B score 0 with invalid-reply rates of 1.00 and 0.45 and are separated *below* random (0.0298); the 7B mean (0.5) sits above the random mean but its 95% CI [0, 1] does not exclude it. On minesweeper the calibrated random agent (0.6625) beats all three models — 0.5B and 1.5B are separated below it, the 7B mean is below but not separated. Repeats the burst8 finding on the new on-ramp tiers: calibrated random is a hard floor for small local models, and minesweeper is the only score tier that discriminates at all.

**Size order: directional, not separated.** Pooled raw episode means are monotone in size — 0.5B 0.0194 (CI [0, 0.058], n=48) < 1.5B 0.0320 (CI [0, 0.083], n=48) < 7B 0.176 (CI [0.031, 0.345], n=20) — and minesweeper alone is perfectly size-ordered (Spearman rho = 1; 0.116 < 0.192 < 0.380, monotone = true). But no pairwise difference separates: the paired-by-seed minesweeper diff 1.5B−0.5B is 0.0757 with 95% CI [−0.269, 0.417] (8 seeds), and every zero-score tier contributes only ties. The answer to the study question is therefore: *models land AT the random floor (not above), and the point ordering is monotone in size but statistically unseparated at these seed counts.*

**What does discriminate today:** process metrics, not scores. Median sec/call scales roughly 12x from 0.5B (0.3–1.0 s) to 7B (6.1–6.6 s) across tiers, and invalid-reply rates separate models on mastermind (0.5B: 1.00; 7B: 0.019) and sokoban (0.5B: 0.571 vs 1.5B: 0.230). If score separation on the on-ramp is the goal, the tiers need either far more seeds on minesweeper-style partial-credit tiers, or scoring that credits partial progress on the zero-floor tiers.

*All numbers above are from stats.json (deterministic, reproduce.sh); seed counts per cell are in the table.*


## Deviations and caveats

- (filled at completion)
- Test suite at this branch's base: 779 tests, 767 pass, 11 fail — all pre-existing on `alpha`, not from this diff (this PR adds only files under `studies/model-separation-v2/solo/`). The 11: ten in `replay/cli.test.js` replay committed burst8-study tictactoe episodes recorded at game version 1.1.0 while the current game is 1.2.0 ("verification failed at step -1 … trajectory recorded game version 1.1.0 but the current game is 1.2.0"), plus one estimator `model-fit basis` test in the same version-drift family. `npm run typecheck` passes.
- `studies/model-separation/models.sha256` lists two 7B names (`qwen2.5-7b-instruct-q4_k_m.gguf`, `…-00002.gguf`) that are byte-identical to the split files (`…-00001-of-00002.gguf` hashes as the first entry, `…-00002-of-00002.gguf` as the second); all four manifest hashes verified OK on the downloaded files.
- Study-local random for nonogram/tiny: bundle `runs-random/nonogram-tiny`, 16 episodes, verdict ok, mean 0.0 (random never solves) — the chance-adjusted floor for that tier is 0, so "above random" means "above 0".
- Sandbox session recycle mid-study (11:05Z): the original sandbox session was replaced by an older snapshot; the pushed commit `f91e127` and origin are authoritative. All model files, llama-server b11662, and the working tree were rebuilt (`fetch-models.sh`, GitHub release tarball); the ladder was relaunched fresh. Runs from before the recycle never completed and were never committed; no committed data predates the relaunch.

## Reproduce

```bash
cd gauntlet && npm ci
bash studies/model-separation-v2/solo/reproduce.sh   # verifies bundles, regenerates stats.json byte-for-byte
```
