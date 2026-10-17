# Separation journey — the researcher's path, replayed

`separation.sh` replays, from a clean clone, the four steps a researcher takes
on the way to a frontier separation pilot — the steps wave 15 built the
tooling for — and exits non-zero on the first failure. It makes no provider
calls: stage C's "model" is the pilot's loopback stub, stage B's probes and
stage E's dial arms are bundled engine baselines.

| Stage | What it replays | Green means |
|---|---|---|
| B | `gauntlet estimate` on the public suite (`--split public --seeds-per-tier 1`), probe episodes on, GNU Go and Stockfish installed | estimate exits on its own within `SEPARATION_ESTIMATE_SECS` and leaves no `gnugo`/`stockfish` process behind (the #103 dispose gap) |
| C | `gauntlet run` against `journeys/pilot/stubs/anthropic.mjs` with `--max-usd-total` low enough to bind, then `--resume` until it finishes or has nothing left it may play | attempt 1 stops `budget`; the settled ledger total never passed the cap; the ledger's kept/unwound split is printed |
| D | one episode against a stub that never replies (`stalled-stub.mjs`), under `--episode-time-limit-ms 8000` | the episode ends `time-limit` promptly, the trajectory replay-verifies, and the stub logs the client closing the connection |
| E | `studies/separation-pilot/instrument.sh` — the preregistered instrument checks | `INSTRUMENT-CHECKS: PASS` (dial 0.25 vs 0.75 SEPARATED; 0.25 vs 0.25 NOT_SEPARATED with D=0 exactly; label swap negates D and its interval exactly) |

## Usage

```sh
gauntlet/journeys/separation/separation.sh [REPO_URL] [REF] [WORKDIR]
```

Defaults: the origin remote and HEAD of the checkout the script lives in, and
a fresh temporary work directory that is kept (its `logs/` holds every stage
transcript). Environment knobs: `SEPARATION_MAX_USD_TOTAL` (stage C cap,
default 0.5), `SEPARATION_ESTIMATE_SECS` (default 900),
`SEPARATION_INSTRUMENT_SECS` (default 2400).

Run it on a quiet box: stage B's no-leftover-engine assertion and stage B's
timing are only meaningful when nothing else is launching engines. Stage E
re-derives the instrument bundles (~10 min, deterministic, untracked).
