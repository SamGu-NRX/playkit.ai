# Model-separation-v2 solo study — REPORT

Study: **do real local models land above random, and in size order, on the solo on-ramp tiers?**
Branch: `obv/burst12-playkit-separation-v2-solo` (from `alpha` @ `72e5543`). Base repo `SamGu-NRX/playkit.ai`.

## Method (pinned before any model ran)

- Models: Qwen2.5-Instruct 0.5B / 1.5B / 7B, GGUF Q4_K_M, served by `llama-server` b11662 (`--temp 0.0 --seed 42 --ctx-size 4096`), `--concurrency 1`, `--max-output-tokens 256`, `--call-timeout-ms 60000`.
- Tiers (the six registered solo on-ramp tiers): `sliding/p8-short`, `sokoban/one-box`, `mastermind/mini`, `cube/cube-2`, `nonogram/tiny`, `minesweeper/beginner`; 8 public seeds per tier.
- Agent: `model:openai-chat/<stem>` on the official track through `cli/gauntlet.js`; every bundle `bundle verify`d (manifest hash + all episodes replayed).
- Random floor: calibration tables from `scoring/generate-baseline.js` (rhae-v1 chance-adjusted profile); `nonogram/tiny` has no calibration table on `alpha`, so a study-local random run (`agents/random.js`, 16 seeds, bundle-verified) measured its floor; that entry carries `studyLocal: true` in `baseline-random.json`.
- Scoring: `scoring/score.js` (profile `rhae-v1`): per-tier score vs random, invalid-reply rates, paired-by-seed model differences, Spearman correlations between models. Aggregation in `compute-stats.mjs` (deterministic; no model files needed to re-run — see `reproduce.sh`).
- 7B wall-clock: measurement-driven. One measured episode per tier sets the seed budget; tiers that do not fit the deadline get 4 seeds or are dropped, and the choice is recorded here. (CPU-only inference; the 110-call nonogram tier dominates.)

## Results

<!-- RESULTS_TABLE -->

## Verdict

<!-- VERDICT -->

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
