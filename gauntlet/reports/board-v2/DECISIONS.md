# Board-v2 decisions — floor profile and paid run

Corrected 13-game benchmark (49-episode pilot suite, one public seed per tier). All model
numbers below are measurements from the local qwen2.5-1.5b run (zero spend) and the
committed calibration tables. Companion docs: `CHANGES.md` (what changed in the benchmark),
`../FLOOR-OPTIONS.md` (profile design), `projection-frontier-full.md` (projection detail).

## Decision 1 — which scoring profile the board should use

**Benchmark score B, measured on the corrected pilot suite:**

| Profile | model: qwen2.5-1.5b | random | Winner |
|---|---:|---:|---|
| rhae-v1 (default) | 0.0301 | 0.0392 | random |
| chance-adjusted | 0.0179 | 0.0092 | model |
| squared-outcome | 0.0168 | 0.0122 | model |

**Per-game G, rhae-v1** (only four games separate the two; everything else is 0–0):

| game | qwen | random |
|---|---:|---:|
| 2048 | 0.2565 | 0.1813 |
| minesweeper | 0.0157 | 0.2741 |
| connect4 | 0.0667 | 0.0000 |
| holdem | 0.0220 | 0.0156 |

Under `chance-adjusted`: 2048 0.1336 vs 0.0444, minesweeper 0.0000 vs 0.0572, connect4
0.0667 vs 0, holdem 0.0140 vs 0.0094. Under `squared-outcome`: same winners, minesweeper
0.0006 vs 0.1112.

**Recommendation: adopt chance-adjusted as the decision board, keep rhae-v1 as the default
headline.** This is FLOOR-OPTIONS' recommendation, and the measured board confirms the
mechanism: under rhae-v1 a uniformly random agent outranks the model because minesweeper
beginner's calibrated random mean (r ≈ 0.66) lets it bank luck — random's minesweeper G
(0.2741) is its single biggest contributor while the model wins 2048, connect4 and holdem.
Chance-adjusted rescales every tier by the committed random mean, and random's aggregate
drops to 0.0092 ≈ 0 by construction — the floor holds. squared-outcome agrees on the winner
and penalizes variance; it stays a sensitivity column, not the board.

Caveats: one seed per tier makes the pilot's 95% intervals degenerate (the leaderboard
prints [x, x]); real intervals arrive with the full-suite paid run (20 seeds/tier). The
chance-adjusted profile requires the committed random baseline, regenerated whenever
calibration tables change (existing PR #36 machinery, byte-deterministic).

## Decision 2 — the paid run

**Pilot (one seed per tier, 49 episodes): verified locally at $0** — 49/49 episodes,
1,969 calls, 0 failures, `bundle verify` ok. Caps used: `--max-calls 2400` (same as the
first-model board).

**Full official public suite: 929 episodes** (per-tier `publicSeeds` summed from the game
specs). Projection (floor = estimator low basis; corrected = measured qwen calls/episode;
budget cap = tier maxActions everywhere). Prices re-checked 2026-10-16 (Opus 5.5 $4/$20,
GPT-6 Astra $10/$50 short-context, Gemini 4 Argon intro $2/$10 through 2026-11-30):

| Model | Pilot floor | Pilot corrected | Full floor | Full corrected | Full budget cap |
|---|---:|---:|---:|---:|---:|
| anthropic/claude-opus-5-5 | 1.35 | 1.31 | 45.31 | 58.91 | 141.46 |
| openai/gpt-6-astra | 3.38 | 3.27 | 113.27 | 147.28 | 353.65 |
| openai-chat/gemini-4-argon | 0.68 | 0.65 | 22.65 | 29.46 | 70.73 |

Expected calls: ~1,969 pilot (measured), ~36,900 full suite. Bracket, not point estimate:
per-game qwen/floor call ratios span 0.06×–15.97×; stronger models survive longer in
engine-opponent games (more calls), invalid-action forfeits end episodes early (fewer).

**Recommendation: first full paid run on Gemini 4 Argon at introductory pricing before
2026-12-01** — expected ≈ $29, capped at $37; after expiry its rates equal Opus 5.5
(≈ $59 expected). Exact commands:

```sh
# Full public suite (all 929 public seeds), build once:
node cli/gauntlet.js suite build --split public --out reports/board-v2/suite.public.full.json

# Run (Gemini intro; cap 1.25x corrected expectation):
node cli/gauntlet.js run --suite reports/board-v2/suite.public.full.json \
  --agent model:openai-chat/gemini-4-argon \
  --out reports/board-v2/runs/run-gemini-4-argon-full \
  --max-calls 46000 --max-usd 37
# Per-model USD caps at the same 1.25x rule: opus-5-5 74, gpt-6-astra 184.
```

## The "~0.11" random-floor number in the brief

The brief said random's B is "about 0.11" under rhae-v1. That number does not reproduce on
the corrected benchmark under any computation tried: measured run B = 0.0392; expected B
from the committed calibration tables with the official rank weighting = 0.0414; equal
per-tier weighting = 0.0581. The wave-6 board's measured random B was 0.0668 on the old
42-episode suite. Likely a carried-over or mis-weighted figure. The decision it feeds is
robust in direction — under every one of those computations random ≥ model on rhae-v1 —
so the profile recommendation stands regardless.

## Chess ratings

`gauntlet rate` over run-qwen, run-random, run-greedy-chess, run-engine-chess: **no numeric
rating for any agent — every chess-covering agent is `loses-everything`** against the
ladder-known paper/wood rungs (the divergent-direction report is the tool's documented
behavior, not a failure). engine-paper/engine-wood/engine-steel lose their own tier games
as White; engine-granite draws (0.5). With no wins anywhere, the data cannot anchor a
rating; this is a model-quality result, not a tooling gap.

## Verification trail

- `bundle verify` over all 18 run dirs: 17 verdict ok; run-engine-chess 4/4 episodes
  verified, manifest ok, no strays, verdict FAILED on score recompute — see the CLI gap
  below. Saved: `bundle-verify-all.txt`.
- Baselines: random and qwen 49 episodes each; 8 greedy + 8 engine per-game campaigns at
  full tier counts (per-game 3–6). All exits 0.
- Leaderboards regenerated under all three profiles (`leaderboards/{rhae-v1,chance-adjusted,squared-outcome}/`).
- `npm test`: 528 tests, 526 pass, 0 fail, 2 skipped; `npm run typecheck`: exit 0.
- Suite manifest sha256 `61fddda7a4a9…`; run out dir `runs/` not ignored (checked).

## CLI gaps found (described, not fixed)

1. **Chess engine baseline cannot be ranked as one entry.** The chess game's engine
   baseline records per-tier agent ids (`engine-paper`, `engine-wood`, `engine-steel`,
   `engine-granite`), so `score()`'s agent-identity check refuses the four-episode
   aggregate and the leaderboard emits four separate unranked entries. Wave 6 recorded the
   same ids but predates the stricter identity check. Per-tier scores are still measurable
   from the verified trajectories (above). Fix belongs in the CLI or the game (single
   baseline agent id), not in this report branch.
2. **Sliding duplicate episodes:** run-greedy-sliding and run-engine-sliding record the
   same optimal-solver agent; passing both directories to the leaderboard produces the
   duplicate-episodes refusal (correct safeguard). Only run-greedy-sliding is included;
   run-engine-sliding stays on disk.
3. **Pre-existing (PR #41 INFO):** `parseArgs` in `cli/gauntlet.js` eats the token after a
   flag (e.g. `--json <dir>` silently drops `<dir>`). Worked around by flag ordering.
