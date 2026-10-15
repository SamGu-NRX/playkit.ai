# First real-model run — findings

> PlayKit Gauntlet, 2026-10-15. All numbers below are measured from artifacts in this directory unless a source is named.

## Run identity
- Suite: one seed per tier, public split, 12 games / 42 episodes (`suite.public.first1.json`), manifest sha256 prefix `61c34a9aa1118f981e96f061` (games ordered small-budget-first).
- Agent: `model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m` (Qwen2.5-1.5B-Instruct Q4_K_M, llama.cpp b11662 = `llama-server 0.6.0-dev (build 11662, commit c0cb53ac4)`, ctx 16384, 8 threads, temp 0, seed 0) over the OpenAI-compatible chat endpoint.
- Caps: `--max-calls 2400` backstop and a 68-minute SIGINT wall stop were armed; neither bound was hit — the run ended when every planned episode had a trajectory (final `run.json`: jobs 42, played/skipped/failed per resume invocation, 0 failed).
- Orchestration: concurrency 4. Three Stockfish-opponent episodes errored on first pass ("no Stockfish binary found"), were replayed after installing Stockfish 17.1 (`GAUNTLET_STOCKFISH=/usr/games/stockfish`); two of those hit an OOM `SIGKILL` while concurrent probe engines from the paused estimate process held ~1.5 GB, and completed on a serial resume once freed.
- Bundle verification: `bundle verify` — episodes 42/42 verified, strays none, score recomputed, verdict `ok`.

## Headline numbers
- Episodes played: **42/42**; all 12 games complete across their public tiers.
- Total agent calls: **1,631**; invalid actions **135 (8.3%)**.
- Tokens: in **1,154,974**, out **4,053** (per-call means ≈ 708 / 2.5).
- Spend at local zero prices: **$0.00**.
- End reasons: **8 budget-exhausted, 20 forfeit-invalid, 14 terminal**. Terminal endings: tictactoe 1, connect4 5, chess-endgames 1, holdem 3, 2048 4. The model forfeited every chess/chess-stockfish/sliding/minesweeper episode and exhausted the budget on every cube/sokoban episode.
- Latency: mean 4.4 s/call across the run. Early-call latencies are inflated (the first ~9 min ran concurrently with the CPU-bound estimate process, which was paused at 20:19 UTC to give the run the box); post-pause per-call latency is the honest figure (per-game means 2.1–8.3 s).

## Estimator check (calls, per game)
Low basis = estimator's engine/greedy baseline mean actions; high basis = per-episode call budget. "Measured" = completed model run calls/episode.

| game | est low/ep | est high/ep | measured/ep | measured / low |
|---|---:|---:|---:|---:|
| tictactoe | 5.0 | 20.0 | 3.0 | 0.60× |
| cube | 7.0 | 35.0 | 35.0 | 5.00× |
| mastermind | — (no low basis) | 36.7 | 11.0 | — |
| connect4 | 10.2 | 30.0 | 3.6 | 0.35× |
| chess-endgames | 2.0 | 49.0 | 18.5 | 9.25× |
| sokoban | 12.0 | 191.7 | 191.7 | 15.97× |
| chess | 58.25 | 150.0 | 4.25 | 0.07× |
| chess-stockfish | — (no low basis) | 15.0 | 5.75 | — |
| sliding | 27.75 | 185.0 | 9.0 | 0.32× |
| minesweeper | — (no low basis) | 288.25 | 3.75 | — |
| holdem | 118.7 | 400.0 | 95.0 | 0.80× |
| 2048 | — (no low basis) | 281.25 | 111.75 | — |

Findings:
1. The estimator is unreliable for a weak model in **both directions**. Flailing games overshoot the low basis by up to 16× (sokoban, chess-endgames, cube): the baseline agents solve in few moves, the 1.5B model wanders until the budget. Fast-forfeit games undershoot up to 13.7× (chess, sliding, connect4, minesweeper): the model burns 3 invalid replies in its first turns and forfeits, while engine baselines play full games.
2. For both budget-exhausted games the measured calls **equal the estimator's high basis exactly** (cube 105 = 3×35; sokoban 575 = 3×191.7): when the model flails, episode length is pinned to the budget cap, which is exactly what the high basis models. The estimator's high column is the reliable bound for weak models; the low column is not.
3. No low basis at all for mastermind, chess-stockfish, minesweeper, 2048 (probe refusals — see `estimate-local/estimate.md`); for those games the estimator provides only the budget cap. The chess-stockfish sf-100k probe also hit an engine `SIGTERM` during estimation (see Reproducibility).
4. Token calibration: the $1/$1 check-price estimate backs out per-game assumed tokens/call of 261–1,293. Where the probe ran the actual model agent, the back-out matches the measured local usage almost exactly (minesweeper 1,293 vs measured 1,293; 2048 559 vs 559; mastermind 577 vs 577) — the check estimate is internally consistent. Where the probe used a scripted agent, assumed tokens/call sit 1–3× below the model's measured usage (chess-endgames 464 vs 650; chess 527 vs 679).
5. Consequence for frontier cost projection: a frontier model will not exhibit the 1.5B's forfeit-collapse, so the qwen-corrected column **understates** strategy-game costs; the floor column understates everything. Treat both as a bracket (see `projection-frontier.md`).

## Invalid actions & rejected replies
- Overall invalid rate 8.3%, but the distribution is bimodal: 0% on tictactoe, cube, connect4, sokoban (the games whose action spaces are single words or short coordinate pairs), and 24–82% on chess (82.4%), minesweeper (80.0%), chess-stockfish (73.9%), sliding (50.0%), chess-endgames (24.3%), mastermind (33.3%).
- SAN chess moves are the hardest format (chess 14/17 invalid). UCI ("e2e4") halves it but still forfeits (chess-stockfish 17/23). Minesweeper's "reveal r c"/"flag r c" two-token form confuses the model into bare coordinates ("reveal 5 5" reversed as "5 5").
- Top rejected replies: 35× `up` (2048/t2048 — repeated illegal move against the wall), 16× `right` (2048/t1024), 9× `e5` (chess/granite), 6× `reveal 5 5`, 6× `flag 5 5` (minesweeper/beginner). The model repeats a stale action when its previous move was rejected — a loop, not a search.

## Baseline ordering & leaderboard
`leaderboard/leaderboard.md` (CLI `leaderboard` over run-qwen + random + per-game baselines; every trajectory replay-verified inside the scoring pass):
- Official track: **model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m — benchmark score 0.0442** (95% CI [0.0442, 0.0442]), 42/42 episodes, $0.00 cost, 8.3% invalid, 38.8 mean actions.
- Baseline track: **random scores 0.0668 — higher than the model's 0.0442**. On this suite's combined score, a uniform random policy beats Qwen2.5-1.5B: random never forfeits (it survives to budget and harvests outcome credit in survival-weighted games) while the model's forfeit-collapse forfeits whole episodes. This is the single most important number in the report.
- Per-game baselines rank only on their own games (17 unranked entries, each missing the other games' episodes — the leaderboard's profile-mixing safeguards flag them rather than mixing). Their per-game mean actions are informative: sokoban-greedy 191.7 actions/episode — **identical to the model's** — vs sokoban-engine 12.0; the model's budget-exhaustion behavior matches the game's greedy baseline, not its engine baseline.
- Sliding is the one game whose greedy and engine baseline specs resolve to the same agent id (`sliding-solver`); passing both dirs to the leaderboard produces a duplicate-episodes refusal, so only one is included. Both dirs are kept on disk.

## Frontier projection
`projection-frontier.md` / `projection-frontier.json` (`project-frontier.mjs`; covers the 27 episodes of the 8 games with a full estimator basis):

| Model | $/MTok in | $/MTok out | USD floor | USD qwen-corrected |
|---|---:|---:|---:|---:|
| Anthropic Claude Opus 5.5 | 4 | 20 | 2.81 | 3.17 |
| OpenAI GPT-6 Astra | 10 | 50 | 7.03 | 7.93 |
| Google Gemini 4 Argon (intro) | 2 | 10 | 1.41 | 1.59 |

- The floor/median-corrected columns agree within ~13% because the median measured/estimator call ratio is 0.8 — the forfeit-collapse offsets the flail-bloat across games. Per-game ratios span 0.07× (chess) to 16× (sokoban); a frontier model without forfeit-collapse should land well above the corrected column on strategy games and near it on abstract games.
- Extrapolated naively to the full 42-episode suite (×42/27), the bracket is roughly **$4.4–4.9 (Opus 5.5), $10.9–12.3 (GPT-6 Astra), $2.2–2.5 (Gemini 4 Argon intro)**; the intro price expires 2026-11-30, after which Gemini matches the Opus input rate with half the output rate.
- Caveats recorded in `prices.frontier.json`: chars/4 tokenizer estimate understates Claude 4.7+ tokens by ~30%; Gemini output price includes thinking tokens; no provider API calls were made — prices are cited from provider pricing pages read 2026-10-15.

## Reproducibility
- Server: `llama-server -m /home/user/work/llm/models/qwen2.5-1.5b-instruct-q4_k_m.gguf --port 8080 -c 16384 -t 8 --temp 0.0 --seed 0`.
- Run: `node cli/gauntlet.js run --suite reports/first-model-run/suite.public.first1.json --agent model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m --base-url http://127.0.0.1:8080 --prices reports/first-model-run/prices.local.json --max-calls 2400 --concurrency 4 --out reports/first-model-run/run-qwen` (resume with `--resume` after installing stockfish, `GAUNTLET_STOCKFISH=/usr/games/stockfish`).
- Baselines: `bash reports/first-model-run/tools/run-baselines.sh` (random + greedy/engine per game with a baseline agent).
- Estimate: `node cli/gauntlet.js estimate --suite <suite> --agent <spec> --prices <prices> --out <dir>`; the $1/$1 check-price run is `estimate-local-check/`.
- Aggregate: `node reports/first-model-run/tools/aggregate-usage.mjs run-qwen` (JSON with `--json`).
- Known environment footnotes: (a) Stockfish 17.1 must be on PATH or `GAUNTLET_STOCKFISH` must be set — the chess-stockfish episodes hard-fail without it; (b) concurrent engine probes + llama-server (5.3 GB RSS) can OOM-kill engine children on an 8 GB box — serialize engine-heavy passes; (c) the estimate process must not run concurrently with the measured run (latency contamination), which is why its first 9 minutes were paused via SIGSTOP.

## Sources
- Anthropic pricing page (docs.anthropic.com/en/docs/about-claude/pricing, "Model pricing" table, Opus 5.5 row + Claude 4.7+ tokenizer note) — read 2026-10-15.
- OpenAI API pricing page (openai.com/api/pricing, standard tier, short context) and developers.openai.com model docs (GPT-6 Astra row) — read 2026-10-15.
- Google Gemini API pricing page (ai.google.dev/gemini-api/docs/pricing, Gemini 4 Argon standard tier, intro-pricing note) — read 2026-10-15.
