# First real-model run — findings (DRAFT skeleton)

> Filled at end of run. All numbers below are placeholders pending measurement.

## Run identity
- Suite: one seed per tier, public split, 12 games / 42 episodes (`suite.public.first1.json`), manifest sha256: TBD
- Agent: `model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m` (Qwen2.5-1.5B-Instruct Q4_K_M, llama.cpp b11662, ctx 16384, 8 threads, temp 0, seed 0)
- Caps: `--max-calls 2400` backstop; SIGINT wall stop at 68 min (timeout -s INT 4080)
- Concurrency 4; stop reason: TBD (`run.json.stopped`)

## Headline numbers
- Episodes played: N/42; games with all tiers complete: N/12
- Total agent calls: N; invalid actions: N (rate %); forfeits: N
- Tokens: in N, out N (per-call means N/N)
- Latency: mean/p50/max ms per call — NOTE: first ~9 min ran concurrently with the CPU-bound estimate process, inflating early-call latency; per-call latency after the estimate was paused is the honest figure.
- Spend at local zero prices: $0.00

## Estimator check (per game)
Table: estimated calls low/high vs measured calls/episode; estimated in+out tok/call (backed out of the $1/$1 check-price estimate) vs measured. Error % per game. Summary sentence on bias direction (estimate low-basis = engine/greedy baseline mean actions; real 1.5B model does X× more calls because ...).

## Reproducibility
- Temperature 0 / seed 0 still produces variation because the server samples greedily per-request; episodes are seed-pinned, opponent policies are deterministic engines, but model replies can vary across identical prompts only via backend nondeterminism (batching). Document any observed nondeterminism.

## Invalid actions & rejected replies
Top 5 rejected reply texts with counts and where they occurred.

## Baseline ordering & leaderboard
Table from leaderboard CLI over [run-qwen, random-run, greedy runs, engine runs]. Official track flagged unranked? (verify profile mixing safeguards)

## Frontier projection
- Price sources (retrieved 2026-10-15): Anthropic Opus 5.5 $4/$20; OpenAI GPT-6 Astra $10/$50; Gemini 4 Argon $2/$10 (intro through 2026-11-30, then $4/$20).
- Projection method: measured tokens/call per game × estimated calls/episode (estimator low, corrected by measured error factor) × price. Caveats: chars/4 tokenizer, Claude 4.7+ ~+30% tokens note, intro-price expiry, thinking tokens included in Gemini output price.
- USD low/high per frontier model: table.

## Reproduce
Commands (server, run, baselines, estimate, verify, leaderboard, aggregation).

## Sources
- Anthropic pricing page (docs.anthropic.com/en/docs/about-claude/pricing, "Model pricing" table, Opus 5.5 row + Claude 4.7+ tokenizer note) — read 2026-10-15.
- OpenAI API pricing page (openai.com/api/pricing, standard tier, short context) and developers.openai.com model docs (GPT-6 Astra row) — read 2026-10-15.
- Google Gemini API pricing page (ai.google.dev/gemini-api/docs/pricing, Gemini 4 Argon standard tier, intro-pricing note) — read 2026-10-15.
