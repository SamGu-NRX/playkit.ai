# PlayKit Gauntlet — first real-model run report

**Date:** 2026-10-15 · **Suite:** `suite.public.first1.json` (12 games, 42 episodes, public split, one seed per tier) · **Model:** Qwen2.5-1.5B-Instruct Q4_K_M via llama.cpp b11662 on 127.0.0.1:8080 · **Spend:** $0.00 (local zero-rate prices)

## What this campaign did

The first end-to-end run of the Gauntlet against a real model: armed the local server, ran all 42 public episodes, replay-verified the bundle, produced the official zero-price estimate plus a $1/$1 check-price estimate, ran random + greedy + engine baselines, generated a leaderboard across all tracks, and projected what the same suite would cost at frontier prices. Every trajectory in the bundle replays cleanly (`bundle verify`: 42/42, verdict `ok`), and the leaderboard scoring pass independently re-verifies every trajectory it ranks.

## Headline results

1. **The model scores 0.0442; a random policy scores 0.0668.** On the combined benchmark score, uniform random beats Qwen2.5-1.5B. The mechanism is forfeit-collapse: the model burns three invalid replies in its first turns on format-hard games (SAN chess 82% invalid, minesweeper 80%, sliding 50%) and forfeits whole episodes, while random never forfeits and survives to harvest outcome credit. Random also burns more calls (2,517 vs 1,631) — it loses slower and thereby scores better.
2. **1,631 agent calls, 1.15M input tokens, ~4k output tokens, 8.3% invalid.** Ends: 8 budget-exhausted, 20 forfeit-invalid, 14 terminal. The model solved the abstract single-word-action games (tictactoe, connect4 terminal endings) and played full terminal sessions of 2048 and holdem, but forfeited every chess-family episode and exhausted the budget on every cube/sokoban episode — where its mean actions (191.7/ep on sokoban) exactly match the game's greedy baseline, not its engine baseline (12.0).
3. **The cost estimator's low basis is unreliable for weak models in both directions** — measured calls land 0.07× to 16× the engine/greedy-basis estimate per game (forfeit-fast games far under, flailing games far over). Its **high** basis (the budget cap) is the reliable weak-model bound: both fully budget-exhausted games hit it exactly. This matters for anyone using the estimator to price runs of unproven models. No low basis exists at all for mastermind, chess-stockfish, minesweeper, and 2048 (probe refusals).
4. **Frontier cost projection (27 estimator-covered episodes):** Opus 5.5 $2.81–3.17, GPT-6 Astra $7.03–7.93, Gemini 4 Argon (intro) $1.41–1.59 — roughly $2.2–12.3 per full 42-episode suite across models (Gemini 4 Argon intro to GPT-6 Astra). Treat as a bracket: forfeit-collapse pushes a weak model below the bracket, and frontier models that survive longer will push above it on strategy games. Prices cited from provider pricing pages (read 2026-10-15); no provider API calls were made.

## Failure-mode summary (what the harness should learn)

- **Format cliffs, not reasoning cliffs, decide weak-model runs.** The invalid-action rate is bimodal: 0% where actions are single words or short coordinate pairs, 24–82% where two-token or SAN formats are required. Every forfeit came from 3 consecutive invalid replies.
- **Rejection loops.** Top rejected replies are repetitions (`up`×35, `right`×16, `e5`×9): the model re-sends a stale action when told it was illegal. A harness-side "your last reply was rejected" nudge, or a reply-echo guard, would materially change weak-model results.
- **Estimator vs reality:** see FINDINGS.md for the full per-game table and the check-estimate token calibration (scripted-agent probes sit ~1.3–1.4× below measured usage; games without an estimator low basis fall back to measured tokens and are not calibration evidence), plus the reproducibility footnotes (Stockfish binary requirement, OOM interaction between concurrent engine probes and llama-server, estimate-vs-run CPU contention).

## Artifact index (all under `reports/first-model-run/`)

| Artifact | What it is |
|---|---|
| `run-qwen/` | 42-episode model-run bundle + `run.json` (verify: ok) |
| `run-random/`, `run-greedy-*/`, `run-engine-*/` | 17 baseline bundles (42 + 3 + 5 + … episodes) |
| `estimate-local/` | Official zero-price estimate (calls low/high per game) |
| `estimate-local-check/` | $1/$1 check-price estimate (tokens/call back-out) |
| `usage-qwen.json` | Measured usage aggregate (calls, tokens, latency, invalids) |
| `leaderboard/` | Scored leaderboard across tracks (`leaderboard.md`/`.json`) |
| `projection-frontier.md`/`.json` | Frontier cost projection (floor vs qwen-corrected) |
| `FINDINGS.md` | Detailed findings: estimator table, rejection analysis, method notes |
| `suite.public.first1.json`, `prices.local.json`, `prices.check.json`, `prices.frontier.json` | Inputs (suite manifest sha256 `61c34a9aa1118f981e96f061…`) |
| `tools/` | `aggregate-usage.mjs`, `project-frontier.mjs`, `run-baselines.sh` |

## Reproduce

Commands in FINDINGS.md → Reproducibility. Short form: start llama-server (temp 0, seed 0) → `gauntlet run --suite … --agent model:… --out run-qwen` → `gauntlet bundle verify run-qwen` → `run-baselines.sh` → `gauntlet estimate` (local + check prices) → `aggregate-usage.mjs` → `gauntlet leaderboard` → `project-frontier.mjs`.

## Verdict

The harness works end to end: suite → run → verify → estimate → baselines → leaderboard → projection, all replay-verifiable and $0 local. The first real number is a sober one — the 1.5B model loses to random on the combined score through forfeit-collapse — and it immediately suggests the two highest-leverage harness features: invalid-reply nudging and per-format warm-up prompts. The estimator needs its low basis labeled as "baseline-basis," not "expected," for unproven agents; its high basis is already the honest weak-model bound.
