# Solver budgets study

Machine-specific paired measurement of what the extension's solver budget buys
on 2048 boards: does a deeper solver produce meaningfully better games than the
production naive fallback, at what per-move latency, under identical spawn
conditions?

**Every number this directory produces is a measurement on the machine that
produced it, on n = 20 seeds. Nothing here is a universal latency or
performance claim.**

## Arms

| arm | engine | purity | status |
|---|---|---|---|
| `naive` | production JS fallback (`src/solver/naive-solver.js`) — also the fallback engine for every other arm | fully JS; every part of move production is auditable JS | run |
| `native-cpp` | the `2048-solver` submodule's C++ strategies (expectimax, heuristic 3, depth 3, probability 0.5, 256 trials), compiled natively with g++ and driven through a persistent-process shim | cross-language: direction conventions pinned by `tests/native-crosscheck.test.mjs`; board state still advances only through the independent reference model | run |
| `wasm` | same C++ sources built by Emscripten through the same embind surface the extension uses | same cross-language caveats, plus a distinct build toolchain | run (local build succeeded; the study build script uses `-sENVIRONMENT=web,node` because the web-only glue cannot load `solver.wasm` from Node's file loader) |

The `wasm` arm is a **separately compiled build** from `native-cpp` (different
toolchain, same C++ sources). They are never presented as one arm.

## Method

- **Frozen spawn histories** (`spawn-history.json`, committed): per-seed
  streams of `[uCell, uValue]` 32-bit draws, generated per game seed
  (`mulberry32(seed)`) and frozen before any arm was evaluated — no arm was
  tuned on these streams. Every arm replays the identical stream for a seed,
  so per-seed outcomes are paired observations.
- **Independent move model**: board state advances only through
  `test/helpers/reference-2048.mjs` (`simulateMove`, spawn cursor). No
  solver-internal simulator ever advances game state.
- **Order-walking with rejection accounting**: engines return a preferred move
  order. Entries that are out-of-range (`illegal`) or board-unchanging
  (`no-op`) under the reference model are rejected and counted; the first
  board-changing entry is applied. The naive arm, whose `getMoveOrder` already
  filters to valid moves, normally applies its first entry.
- **Declared budgets**: `timeBudgetMsPerMove: 200` (wall clock, JS round-trip
  including IPC), `maxMovesPerGame: 5000`. Games that hit a budget end
  declared as `truncated` / `spawnExhausted` — never silently.
- **Fallbacks**: on timeout, engine error, or an order with no legal entry,
  the naive arm supplies the applied move (canonical Up,Right,Down,Left if
  naive itself were unavailable). Raw engine output is committed either way,
  and fallback usage is counted per arm.
- **Identity**: every run commits `identity.json` — git HEAD, submodule state,
  SHA-256 of every source file and binary involved, machine description, and
  the manifest hash.
- **Replay**: `--replay` re-simulates every recorded game from its committed
  raw record and verifies per-step score/max-tile progression and final-board
  agreement. Results below ship with their replay witness.
- **Paired statistics**: `--analyze` computes percentile-bootstrap 95%
  confidence intervals for paired per-seed differences in final score and max
  tile reach (10,000 resamples, fixed seed for reproducibility), plus paired
  tile-reach win/tie/loss counts vs the baseline.

## Direction conventions

The C++ solver's move indices are **Right, Down, Left, Up** (0..3, pinned
empirically); the project's JS convention is **Up, Right, Down, Left** (0..3).
The mapping `C++→JS = [1, 2, 3, 0]` is applied in every cross-language binding
and verified by `tests/native-crosscheck.test.mjs`, which replays the shim's
own move simulation against the independent reference model. The production
WASM glue (`src/`) carries the same convention question; this study does not
change `src/`.

## Running

```bash
# one-time: build the native arm (stages submodule headers, applies the
# int64_t compatibility shim in the build dir only — submodule and src/ untouched)
bash experiments/solver-budgets/native/build-native.sh

# regenerate the frozen spawn fixture (deterministic; committed)
node experiments/solver-budgets/tools/generate-spawn-history.mjs

# play all games (naive + whatever arms built)
node experiments/solver-budgets/run.mjs --manifest experiments/solver-budgets/manifest.json

# verify replay agreement and compute paired intervals
node experiments/solver-budgets/run.mjs --replay   experiments/solver-budgets/results/<run-dir>
node experiments/solver-budgets/run.mjs --analyze  experiments/solver-budgets/results/<run-dir>

# tests (runner semantics, native convention cross-check, replay verification)
node --test experiments/solver-budgets/tests/
```

## Results

See `results/RUN.md` for the latest run's summary, replay witness, and paired
intervals, and `results/<run-dir>/` for raw per-move records, control counts,
and identity. Results directories are committed raw — no post-hoc filtering.

## Scope limits

- n = 20 seeds per arm; paired intervals are wide; ties are common.
- Latency is wall-clock JS round-trip and includes IPC for the native arm —
  it is not a solver-throughput benchmark.
- The 200 ms budget and 5,000-move cap are declared, not tuned; changing them
  invalidates comparability with committed results.
- The study never edits `src/`, the submodule, or the browser benchmark.
