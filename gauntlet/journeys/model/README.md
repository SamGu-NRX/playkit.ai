# Model journey: point Gauntlet at a local model

This directory is the repeatable kit for the "serve a real open-weight model
locally and run Gauntlet against it" journey. `journey.sh` repeats the whole
suite run given a server URL; the individual steps it automates are documented
below so each can also be run by hand.

## What a user needs (the 6-step path)

1. **Get a server.** The path exercised end to end is llama.cpp's
   `llama-server`: download a release binary (or build), e.g. the
   `b11662` Ubuntu/x64 asset used here. See `harness/PROVIDERS.md`
   ("Serving a local model").
2. **Get a model.** Any GGUF. The two used here are Qwen2.5-1.5B-Instruct and
   Qwen2.5-7B-Instruct, Q4_K_M, Apache-2.0; SHA-256 values are pinned in
   `studies/model-separation/models.sha256`.
3. **Serve it** on 127.0.0.1:
   `llama-server -m <model>.gguf --host 127.0.0.1 --port <port> --temp 0 --seed 42`
   (deterministic sampling; check `curl <url>/health`).
4. **Pick a price file.** The server is free, but `costUsd` stays `null` until
   a price file names the model — and a `--max-usd` run refuses on unknown
   costs. `prices.nominal.json` prices both Qwen models at a nominal rate so
   the cap is exercised. Copy and edit it for any other model.
5. **Play one episode:**
   `node cli/gauntlet.js play --game tictactoe --tier perfect-opponent \
     --seed tictactoe/perfect-opponent/public/0 \
     --agent model:openai-chat/<model> --base-url <url> \
     --max-output-tokens 256 --call-timeout-ms 60000 \
     --prices <prices.json> --out /tmp/t.json`
   then `node cli/gauntlet.js verify /tmp/t.json`.
6. **Run a suite with bounds:** `bash gauntlet/journeys/model/journey.sh <url>`
   builds a public suite, estimates first, runs with `--concurrency`,
   `--max-usd`, `--max-output-tokens`, `--call-timeout-ms`, bundle-verifies,
   compares estimate vs actual, and writes a leaderboard per scoring profile.

## Files

- `journey.sh` — the repeatable suite run (server URL as arg 1; env overrides
  documented in the header).
- `prices.nominal.json` — nominal local prices so the dollar cap is real.
- `estimate-check.mjs` — prints estimate-vs-actual error from a run's
  `run.json` and the pre-run estimate.

## What runs where

Run bundles are written under `RUNS_ROOT` (default
`./gauntlet-journey-runs`): run outputs, trajectories and estimates are data,
not source, and stay out of the repository.

## Journey notes (from actually running this path, 2026-10-16)

- The docs read in order: `gauntlet/README.md` (CLI + agent specs) →
  `harness/PROVIDERS.md` (server recipe + provider table). The path is
  complete, but the sampler flags (`--temp 0 --seed 42`) are not documented
  anywhere: PROVIDERS.md's serve command omits them, so a first-time user
  gets nondeterministic sampling without knowing.
- A busy port surfaces only as a llama-server bind error; `journey.sh`
  health-checks the server first and says so explicitly.
- Episode costs are visible per step in the trajectory (`steps[i].usage`)
  and summed in `run.json` (`spendUsd`); the `play` command itself prints no
  cost line, so a user pricing one episode must inspect the JSON.
- The estimator's probe episodes (engine baselines on chess-stockfish and
  chess tiers) can take longer than the model run itself on a small box;
  there is no flag to skip the low-basis probes.
- `run.json` provenance is per-invocation: after a `--resume`, its `calls` and
  `spendUsd` cover only the episodes played by the resuming invocation, so a
  full-run total must be summed from the trajectories (which do carry
  per-step usage). `estimate-check.mjs` does that sum when it detects a
  resumed bundle.
- A `--max-usd` cap binds as a pre-reservation refusal: the run prints
  `stopped budget — <job>: maxUsd reached (settled …, reserved …, next-call
  worst case …)` and exits 1 with run.json written; `--resume` then skips the
  verified episodes and replays the rest. The cap refuses before the first
  call if the cap is below one call's worst-case quote.
- `chance-adjusted` leaderboards refuse when a committed baseline is older
  than the game version in a trajectory; at alpha this fires for tictactoe
  (`games/tictactoe/index.js` declares 1.2.0, `scoring/baselines/random-public.json`
  records 1.1.0 — the 0c5140a bump landed after the 84ce154 recalibration).
  `rhae-v1` and `squared-outcome` are unaffected.
- The 7B Instruct model does not stop at the bare move: it fills the whole
  `--max-output-tokens` budget with chatter the runner then extracts the move
  from. On CPU (llama.cpp b11662, 8 threads) that is ~24 s per call at
  256 tokens, so a full 150-action sokoban episode is best treated as an
  overnight-grade run; the 1.5B emits 1–3 tokens and finishes in minutes.
