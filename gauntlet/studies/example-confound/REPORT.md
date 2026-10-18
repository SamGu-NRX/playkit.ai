# Example-confound study report: corrected-example rerun on mastermind/mini + a connect4 neutral-example control

Study branch `obv/burst15-playkit-example-confound` off `alpha` at `33dca72`. Preregistration: [PREREGISTRATION.md](./PREREGISTRATION.md) (committed `05c7595`, amended `f8e70b0` before any model run). All bundles replay-verify through the standard verifier; every number below is recomputed from the committed bundles through the official scorer (`scoring/score.js`) by [compute-stats.mjs](./compute-stats.mjs).

## Question

PR #90's mastermind/mini tier and PR #92's connect4 example-copier study both put a worked example in the prompt. #81/#97 showed the Qwen2.5 0.5B/1.5B solo-study models failing mastermind (the 0.5B's invalid-reply rate ~1.00 — it copies the example's wrong-length guess format), and #92 showed the 0.5B winning connect4/ladder-1 at 0.9888 with a copiable example in the prompt. This study reruns both with the example corrected at prompt time, to split "the tier is too hard" from "the prompt's example taught the failure" (mastermind), and to check how much of the connect4 strength was example-copying (control arm).

## Method

- **Arms** (preregistered): `corrected-official` (patch(model)) and `corrected-assisted` (patch(assisted(model, retries 2))) on mastermind/mini, 8 public seeds, per model; `connect4-neutral` (patch(model)) on connect4/ladder-1, 12 public seeds, per model. The patch stack applies the preregistered exact replacements — the wrong-length worked example in the rules text, the observation example — and refuses missing/ambiguous targets; it records what it applied in the reply metadata. Mastermind only: a third preregistered patch (empty-action feedback) was retired before any run — the runner's `no action found in reply` precedes the game's empty-action message, so that site has no example to correct.
- **Serve** (pinned, identical to model-separation-v2): llama.cpp `b11662` (commit `c0cb53a`), ctx 4096, temp 0, seed 42, threads 8, one warm-up call; concurrency 1, 256-token reply cap, 60 s call timeout. `serve-and-run.sh` + `run-arm.mjs` reproduce every episode.
- **Comparisons** (preregistered): paired-by-seed seeded bootstrap (10,000 draws) for assisted-minus-official and 1.5b-minus-0.5b; arm-vs-floor against the committed calibration random rows; connect4 additionally against #92's committed example-copier mean (prose citation).
- **Track**: the example-patch agent is a community-track wrapper (`community-example-patch:...`), so the official leaderboard is untouched by construction; no core files changed.

## Deviations (recorded before or during the run)

1. **The task brief's "alpha is at 33dca72 with mastermind 1.1.1" premise does not hold.** At `33dca72` the registered mastermind version is **1.0.0** and the corrected-example change (#99) is **not merged** — the uncorrected examples are in the rules text at the base, which is exactly what the preregistered patches target. Episodes, the calibration random floor, and the scoring baselines are all consistently at 1.0.0; the comparison is version-aligned at 1.0.0. No rebase or version bump was needed or performed.
2. **Two idle prior-burst compute jobs (burst8/burst9 sessions `accrun`/`paired-ev`) were SIGSTOPped mid-run** to free ~2 of 8 cores for the pinned serve; reversible (`SIGCONT` restores them), disclosed here. No other change to the box.
3. **A sandbox recycle had wiped llama.cpp and the GGUFs**; they were refetched (llama.cpp rebuilt at the pinned tag; models re-downloaded from the official Qwen HF repos, sha256 below).
4. First small-model launch aborted after arm 1 by a script path bug (`GDIR` pointed at the repo root, so `bundle verify` could not find the CLI); fixed (`25f94e2`) and relaunched with `--resume`, which skips the already-written bundles — byte-equivalent under the pinned temp-0/seed-42 serve.

## Results

| model | arm | n | mean | 95% CI | invalid steps | eps w/ invalid | ends | sec/call |
|---|---|---|---|---|---|---|---|---|
| 0.5B | corrected-official | 8 | 0 | [0, 0] | 9.9% | 100% | 5 budget-exhausted+3 forfeit-invalid | 1.66 |
| 0.5B | corrected-assisted | 8 | 0.125 | [0, 0.375] | 1.9% | 12% | 7 terminal+1 forfeit-invalid | 1.06 |
| 0.5B | connect4-neutral | 12 | 0.75 | [0.5, 1] | 0.0% | 0% | 12 terminal | 0.28 |
| 1.5B | corrected-official | 8 | 0 | [0, 0] | 75.0% | 100% | 8 forfeit-invalid | 1.30 |
| 1.5B | corrected-assisted | 8 | 0 | [0, 0] | 100.0% | 100% | 8 forfeit-invalid | 15.65 |
| 1.5B | connect4-neutral | 12 | 0.75 | [0.5, 1] | 0.0% | 0% | 12 terminal | 0.54 |
| 7B | corrected-official | 8 | 0.25 | [0, 0.625] | 0.0% | 0% | 8 terminal | 6.68 |
| 7B | connect4-neutral | 12 | 0.6667 | [0.4167, 0.9167] | 0.0% | 0% | 12 terminal | 2.90 |

### Mastermind/mini: corrected examples alone (arm 1, floor 0.02985)

- **0.5B: mean 0.0** (CI [0, 0]), 5/8 budget-exhausted + 3/8 forfeit-invalid, 9.9% invalid steps. Point estimate at/below the random floor; above-random NO. But the failure mode changed: #81's uncorrected 0.5B had a ~1.00 invalid-reply rate (it copied the example's wrong-length format); with the example corrected, 5/8 episodes play the full 25-guess budget legally. **Correcting the example fixed format-copying, not solving.**
- **1.5B: mean 0.0** (CI [0, 0]), 75% invalid steps, all 8 forfeit-invalid. The 1.5B cannot produce legal guesses even with correct-length examples — its floor was never the example.
- **7B: mean 0.25** (CI [0, 0.625]), zero invalid steps, all 8 terminal. The only model that converts the corrected example into clean play; point estimate sits above the floor but the interval contains it, so above-random is NO by the preregistered interval reading and YES only by point estimate (n=8).

**Answer to the mastermind half: partly.** The corrupted example was actively teaching the smallest model an illegal format (fixing it cut the 0.5B's invalid-step rate ~10x), but it was not what kept them below random — with every known example corrected, 0.5B and 1.5B still score 0.0 and only the 7B reaches clean above-floor point play.

### Mastermind/mini: assisted on top (arm 2, paired by seed)

- 0.5B: assisted-minus-official **+0.125** (CI [0, 0.375], n=8) — direction positive, not separated; invalid steps 9.9% -> 1.9%, forfeits 3 -> 1. Assistance converts the 0.5B's format failures into legal turns.
- 1.5B: **+0.0** (CI [0, 0], n=8) — no rescue; invalid steps go 75% -> 100% and sec/call balloons 1.3 s -> 15.6 s (three attempts exhausted every turn, forfeit-invalid every episode). Replicates #97's finding: the 1.5B emits syntactically perfect `guess ABCD` lines whose guess is not legal — the floor is not a format problem.
- Size ordering does not appear: 1.5b-minus-0.5b on corrected-official is +0.0 (CI [0, 0], n=8).

### connect4/ladder-1 neutral-example control (arm 4, floor 0.4167)

| model | mean | 95% CI | vs #92 example-copier 0.9888 |
|---|---|---|---|
| 0.5B | 0.75 | [0.5, 1.0] | -0.24 |
| 1.5B | 0.75 | [0.5, 1.0] | (no #92 run; same pattern) |
| 7B | 0.667 | [0.417, 0.917] | (no #92 run) |

- **The 0.5B's 0.9888 under #92's copiable example collapses to 0.75 without any example** (-0.24 on the identical game/tier/seeds): most of the with-example strength was copying the worked example.
- What remains still beats random by point estimate and the random floor mean (0.4167) lies **below** the 0.5B/1.5B CI lower bound (0.5) — the models separate from the random floor mean on the interval reading; the floor's own CI [0.17, 0.67] overlaps theirs, so the honest read is "clear of the random point, not of the random interval." The 7B's CI contains the floor mean entirely.
- No size ordering: 0.5B and 1.5B tie at 0.75 and the 7B is nominally lower (0.667).

**Answer to the connect4 half: largely yes.** Removing the copiable example costs the same model a quarter of its win rate; what survives example removal is real but modest play against a random opponent.

### Addendum (2026-10-17): compute-stats fixed to the preregistered shape

PR #104 review findings, now fixed in `compute-stats.mjs` (helpers in
`stats-lib.mjs`, unit-tested in `stats-lib.test.mjs`):

- **Arm parsing** read the arm from a non-greedy regex that misparsed the
  connect4 control (`...-connect4-neutral-connect4-ladder-1-12` parsed as the
  arm "connect4-neutral-connect4", matching nothing). Arms are now matched by
  known prefix; every committed suite id parses.
- **The random-floor gap hardcoded the mastermind/mini floor** for every arm
  behind a guard that could never fire. Each run now takes its OWN tier's
  floor — the connect4 control gets the calibrated connect4/ladder-1 floor
  (prereg H3).
- **H2's statistic was omitted**: the tie-corrected Spearman rho (Pearson on
  mid-ranks, "as in #81") over the three per-model corrected-official means is
  now computed. From the committed means (0.5B 0, 1.5B 0, 7B 0.25) the
  corrected script yields **rho = 0.866025** (n=3): with the format trap
  removed, means order by parameter count — the tie-corrected reading of H2's
  "yes".
- **H1's preregistered cross-study comparisons were omitted**: the corrected
  arms are now paired by seed against the prior studies' committed bundles
  (`--prior-official-runs` / `--prior-assisted-runs`; #97's assisted bundles
  are in-repo and compared by default, #81's official bundles are not
  committed here so that comparison records a note until the bundles are
  available). Prior bundles carry their recorded game version, so a scorer
  refusal at the registry's current version is recorded in stats.json rather
  than swallowed.

`stats.json` itself is NOT regenerated: the scorer still refuses the committed
mastermind 1.0.0 bundles against registry 1.1.0 — the pre-existing blocker
recorded above — so the committed tables stand and the corrected script is
what future regeneration will produce.

## Provenance

Every episode is a community-track bundle (`community-example-patch:...` agent ids in run.json and trajectories); the official leaderboard is untouched by construction. All 56 bundles pass `gauntlet bundle verify`. stats.json is deterministic (seeded bootstraps, no timestamps).

## Reproduce

```bash
cd gauntlet/studies/example-confound
bash run-small-models.sh   # 0.5B + 1.5B, arms 1+2+4
bash run-7b.sh             # arm 3 (+ arm 4 for 7B last, per the drop order)
node compute-stats.mjs     # stats.json from the committed bundles
                           # [--prior-official-runs <dir>] [--prior-assisted-runs <dir>]
                           # fixed per the PR #104 review; see the addendum
node cli/gauntlet.js bundle verify studies/example-confound/runs/<model>/<arm-dir>
```

## Model checksums

```74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db  qwen2.5-0.5b-instruct-q4_k_m.gguf```
```6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e  qwen2.5-1.5b-instruct-q4_k_m.gguf```
```dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db  qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf```
```539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a  qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf```
```SHAS-DONE```
