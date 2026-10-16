# Does the suite rank 0.5B, 1.5B and 7B in order? A local separation study

**Study:** `studies/model-separation` · **Branch:** `obv/burst8-playkit-model-separation`
**Date:** 2026-10-15/16 · **Hardware:** one 8-core Linux sandbox, 7.8 GB RAM, CPU-only inference (llama.cpp b11662)

## Verdict

**No — at 4 seeds per tier, the suite does not rank 0.5B < 1.5B < 7B in order.** The pooled
same-games means are 0.167 / 0.204 / 0.188: 1.5B edges out 7B on point estimate, driven by a
single lost connect4 ladder episode, and every confidence interval overlaps. Five of seven games
score 0.0 for every model. The only game that orders the models in the expected direction —
minesweeper/beginner — is also the game where a random agent (0.694) beats all three models.
What the suite does separate cleanly at this budget is *process*, not outcome: invalid-reply rate
(1.5B is the wild one at 23.4%) and latency (7B costs ~9x 0.5B per call).

## Question

The Gauntlet suite's headline claim is that it measures agent ability. The cheapest possible check of that claim is whether a ladder of same-family models of increasing size — Qwen2.5-Instruct at 0.5B, 1.5B, and 7B, all Q4_K_M, all served identically — comes out ranked in order on the seven short-episode games, with differences larger than seed noise.

**Load-bearing assumption:** suite score is caused by model capability, not by prompt-format familiarity or reply-length artifacts. Evidence that would break it: a size ordering that inverts on outcome games while invalid-reply rates stay flat, or scores that track prompt length rather than ability. What we check: per-game means with bootstrap CIs, invalid-reply rates, and seconds/tokens per call alongside every score. The first break-evidence pattern is exactly what we found on connect4 (see Results).

## Design

- **Games (one tier each):** tictactoe/perfect-opponent (outcome), mastermind/classic (efficiency), connect4/ladder-1 (outcome), sliding/p8 (efficiency), sokoban/two-box (efficiency), minesweeper/beginner (outcome), cube/cube-5 (efficiency). Game versions: tictactoe v1.1.0, all others v1.0.0.
- **Seeds:** the 4 public seeds per tier (28 jobs). This is the budget decision — see "Seeds per tier" below for what it buys and what it costs.
- **Models:** Qwen2.5-Instruct 0.5B / 1.5B / 7B, Q4_K_M, SHA-256 in `models.sha256`. Apache-2.0. No model files are committed; they are re-downloadable by URL (see `reproduce.sh` header comment).
- **Serving:** llama-server b11662, `--ctx-size 4096 --temp 0.0 --seed 42 --threads 8`, one model at a time, one warm-up call before the suite. Sampling is pinned at the server because the openai-chat provider spec records no per-request sampling params.
- **Track:** official track only — `model:openai-chat/<model>` through the same harness as any external agent. Every run emits a verified bundle (`bundle verify` ok, strays none) with trajectories carrying per-call milliseconds and token usage.
- **Baselines:** `random` on all seven games, and the per-game `greedy` baseline on the five games the CLI wires (tictactoe ships no baseline agent; cube's baseline is not in the CLI's baseline-spec map). These run in seconds and give the floor the models must clear.
- **No paid calls, no API keys:** everything runs against 127.0.0.1.

### 7B coverage deviation (documented, not silent)

The 7B run is 24/28 jobs, split across two bundles:

- `runs/qwen2.5-7b` — 16 verified trajectories (tictactoe, mastermind, connect4, sliding). The run was stopped mid-sokoban: every sokoban turn made the 7B ramble to the harness reply cap (`max_tokens` 4096, hardwired in the openai-chat provider spec — the CLI exposes no override) at ~9 tok/s on CPU, i.e. up to ~4.5 minutes per agent call, with no bound short of the context window. Wall-clock for the four sokoban episodes exceeded the study window. The killed run's trajectories verify 16/16 individually; it has trajectories and `suite-full.json` but no `run.json` (the runner writes provenance only at completion).
- `runs/qwen2.5-7b-part2` — complete bundle (8/8 verified, `bundle verify` ok, strays none) for minesweeper + cube on the same server, config, and seed settings.

**This is itself a robustness finding:** the invalid-reply forfeit (3 consecutive invalid replies) bounds *count*, not *wall time*. A model that produces long garbage instead of short garbage stretches an episode unboundedly, and latency-based cost analysis would be dominated by it. Sokoban is reported as "not played" for 7B; all cross-model comparisons below use the six shared games.

## Results

Pooled over the six games every model played (24 episodes each):

| Model | Pooled mean | Invalid-reply rate | Sec/call | Tok in/out per call |
| --- | --- | --- | --- | --- |
| Qwen2.5-0.5B | 0.1667 | 4.2% | 0.39 | 575 / 2.2 |
| Qwen2.5-1.5B | **0.2042** | 23.4% | 0.58 | 560 / 2.7 |
| Qwen2.5-7B | 0.1884 | 2.2% | 3.39 | 581 / 2.4 |

Per game (mean episode score over 4 seeds; episode scores in `stats.json`):

| Game | 0.5B | 1.5B | 7B | random | greedy | Reads as |
| --- | --- | --- | --- | --- | --- | --- |
| tictactoe/perfect-opponent | 0.000 | 0.000 | 0.000 | 0.125 | — (none wired) | All models lose to the perfect player; nothing separates |
| mastermind/classic | 0.000 | 0.000 | 0.000 | 0.000 | 0.948 | Nothing solves; greedy is the only signal |
| connect4/ladder-1 | **1.000** | **1.000** | 0.750 | 0.500 | 1.000 | Near-trivial; 7B lost one episode — separates *against* size |
| sliding/p8 | 0.000 | 0.000 | 0.000 | 0.000 | 1.000 | Nothing solves |
| sokoban/two-box | 0.000 | 0.000 | not played | 0.000 | 0.250 | Nothing solves |
| minesweeper/beginner | 0.000 | 0.225 | **0.380** | **0.694** | 1.000 | Orders the models — but random beats all of them |
| cube/cube-5 | 0.000 | 0.000 | 0.000 | 0.000 | — (not wired) | Nothing solves |

Overall means with 4 seeds/tier carry bootstrap 95% CIs of roughly ±0.15 — the three models are statistically indistinguishable on every game except connect4, which separates in the wrong direction.

Observations the outcome table hides:

- **1.5B is the chaos model.** Its invalid-reply rate (23.4% overall; 100% on mastermind) is 5-10x its siblings. 0.5B and 7B are comparatively clean (4.2% / 2.2%). If the suite is meant to rank capability, it also quietly ranks discipline — in a non-monotone order.
- **Latency is the cleanest separator.** 0.39 → 0.58 → 3.39 s/call. On CPU serving, the cost of moving from 1.5B to 7B is ~6-9x per call with no outcome gain on this suite.
- **Minesweeper's model ordering sits below random.** The per-model ordering (0 < 0.225 < 0.380) is the only monotone signal on the suite, but a random clicker scores 0.694 under the outcome rule (safe-reveal fraction before stepping on a mine), so the "signal" mostly measures how well a model avoids random-looking doom, not reasoning.

## Seeds per tier

Two-sample z-approximation (n = 2·z²·s_p²/Δ², pooled per-episode SD, floored at 4) for separating 1.5B from 7B per game:

| Game | Observed gap (7B − 1.5B) | Seeds/tier needed |
| --- | --- | --- |
| tictactoe | 0.000 | infinite |
| mastermind | 0.000 | infinite |
| connect4 | −0.250 | 16 |
| sliding | 0.000 | infinite |
| sokoban | — (7B not played) | — |
| minesweeper | +0.155 | 59 |
| cube | 0.000 | infinite |

The suite's floors are degenerate at these tiers: on four games the 1.5B-vs-7B gap is exactly zero (all scores 0), so no seed count separates them. Where the gap exists, it needs 16-59 seeds per tier per game — 4-15x the public seed budget — and one of the two "separable" games (connect4) separates in the wrong direction at n=4.

## Reproducing

See `reproduce.sh` in this directory: builds the same manifest, runs baselines, serves each model, runs the suite, verifies every bundle, builds the leaderboard. End to end on the 8-core box: about 3 hours wall clock (0.5B ≈ 7 min, 1.5B ≈ 18 min, 7B ≈ 2 h) — *assuming the sokoban rambling is bounded as described in the deviation note; unbounded, add arbitrarily more*.

## Artifacts in this directory

| File | What it is |
| --- | --- |
| `build-suite.mjs` | Manifest generator (tier selection the CLI suite builder lacks) |
| `suite.public.json` | The 28-job manifest the model runs consumed |
| `suite.part2.json` | The minesweeper+cube fallback manifest for the 7B part-2 bundle |
| `models.sha256` | SHA-256 of the three GGUF files |
| `reproduce.sh` | End-to-end reproduction script |
| `compute-stats.py` | Per-game statistics and seeds-per-tier estimation (merges both 7B run dirs) |
| `runs/qwen2.5-0.5b` | Verified 0.5B run bundle (28 trajectories) |
| `runs/qwen2.5-1.5b` | Verified 1.5B run bundle (28 trajectories) |
| `runs/qwen2.5-7b` | 7B full-suite run, stopped mid-sokoban: 16 individually verified trajectories |
| `runs/qwen2.5-7b-part2` | Verified 7B minesweeper+cube bundle (8/8) |
| `stats.json` | Computed statistics |
| `REPORT.md` | This report |

## Known limitations

- 4 seeds per tier is thin for per-game CIs; the seeds-per-tier section quantifies what each game actually needs (16-59 seeds/tier where a gap exists at all).
- 7B sokoban was not played (wall-clock deviation above); all cross-model claims use the six shared games.
- The baseline map covers five of seven games; tictactoe and cube baselines exist in the codebase but are not wired through the CLI (noted in burst8 scope, not fixed here).
- Sampling parameters live at the server, not in run manifests; comparability across models rests on identical server settings, recorded here and in `reproduce.sh`.
- Scores for efficiency games reward solving with fewer actions; models that never solve score 0 regardless of how close they got.
- The reply-length cap is fixed at 4096 by the provider spec with no CLI override; a per-request cap would bound the wall-clock failure mode documented above but was left untouched to keep the official track unmodified.
