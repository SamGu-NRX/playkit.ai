# Latest run — 2026-10-11T01-59-11-757Z

Full directory: `run-2026-10-11T01-59-11-757Z/` (raw per-move records, control
counts, `identity.json`, `paired-intervals.json`, `replay-agreement.json`).
All numbers below are from this run on the machine that produced it (see
`identity.json` for git HEAD, submodule state, binary hashes, and machine
description).

**Scoring change — not comparable with run-2026-10-10T20-34-13-618Z.** This
run uses standard 2048 merge scoring (each merge earns the resulting tile's
value via the reference model's `moveGain`; spawns earn nothing). The earlier
run used tile sums. Numbers across the two runs must not be compared.

## Configuration

- Manifest: `experiments/solver-budgets/manifest-adapter.json` (hash recorded
  in `identity.json`). Depth 3 (not 4–5) because the pre-run latency probe
  showed depth 4 and 5 exceeding the 200 ms/move budget on this machine.
- 20 frozen seeds, 200 ms/move wall-clock budget, 5,000-move cap.
- **Four arms ran: `naive`, `native-cpp`, `wasm`, `adapter`.** No arm was
  unavailable (`armsNotRun: []`); the study-local WASM build
  (`build/wasm/`) was present and loadable on this machine.
- The `adapter` arm is new: it drives the ACTUAL production orchestration
  path — `src/solver/solver-manager.js` `SolverManager` (ensureBoard,
  engine dispatch, wasm→naive declared fallback) exactly as the extension
  runtime constructs it. Every adapter move is recorded with
  `meta.engine` and `meta.managerStatus`; on this machine the real
  `solver.wasm` is absent from the src loader path, so the manager served
  every move from its declared naive fallback (`managerStatus: fallback`,
  `meta.engine: naive`) — recorded per move, never hidden. The study-local
  `wasm` arm remains a separately compiled build and is never merged with
  the adapter arm.

## Replay witness

`80/80 games agree (final-board agreement 100.0%)` — all four arms,
re-simulated from the committed raw records against the independent
reference model, with score progression checked against the reference
model's independent `moveGain` expectation.

The headline replay result is the adapter arm: **adapter vs naive paired
score difference is exactly 0.0 (CI 0.0 .. 0.0, n = 20, tile reach 0/20/0
W/T/L)** — the actual production orchestration path reproduced the
reference-driven naive arm's games move-for-move on every seed.

## Paired outcomes vs the naive baseline (n = 20, bootstrap 95% CI)

| comparison | paired score diff mean | 95% CI | tile reach W/T/L |
|---|---|---|---|
| `adapter` vs `naive` | 0.0 | 0.0 .. 0.0 | 0/20/0 |
| `native-cpp` vs `naive` | +50792.6 | 42253.6 .. 59436.5 | 20/0/0 |
| `wasm` vs `naive` | +50792.6 | 42253.6 .. 59436.5 | 20/0/0 |

The native-C++ and WASM arms' intervals overlap almost entirely; within this
run they are statistically indistinguishable from each other, and both beat
the naive fallback on every seed. These are machine-specific measurements —
not portable performance claims. Mean final scores: naive/adapter 2,323
(max tile 128–512 across seeds), native-cpp/wasm 53,115 (max tile 1,024–4,096).

## Per-move latency (wall-clock JS round-trip; includes IPC for native-cpp)

| arm | moves | p50 | p95 | max | over 200 ms budget |
|---|---|---|---|---|---|
| naive | 4,217 | 0.01 ms | 0.03 ms | ~1.7 ms | 0 |
| native-cpp | 50,683 | ~0.9 ms | ~5 ms | ~45 ms | 0 |
| wasm | 50,683 | ~0.9 ms | ~5 ms | ~820 ms | 0 in this run |
| adapter | 4,217 | ~0.02 ms | ~0.05 ms | ~1 ms | 0 |

## Control counts

Zero timeouts, fallbacks, rejected-illegal, rejected-no-op, truncated, or
spawn-exhausted games in all four arms. All 80 games reached game-over.
The `adapter` arm's per-move `meta.engine: naive` + `managerStatus:
fallback` is the production wasm→naive declared fallback (real solver.wasm
absent in this environment), not a runner-level fallback.

## What the 200 ms budget bought

At this depth-3 configuration the deep arms did not come close to the budget.

## Unavailable arms — policy

`run.mjs` records any arm whose build or binding fails as `armsNotRun` with
the reason — never estimated, never silently dropped — and `--analyze`
marks any arm with an over-budget move failed/unavailable and excludes it
from paired comparisons. This run had none; the policy is the contract.

---

# Earlier run — 2026-10-10T20-34-13-618Z (tile-sum scoring; superseded for comparison)

Full directory: `run-2026-10-10T20-34-13-618Z/` (raw per-move records, control
counts, `identity.json`, `paired-intervals.json`). All numbers below are from
this run on the machine that produced it (see `identity.json` for git HEAD,
submodule state, binary hashes, and machine description).

## Configuration

- Manifest: `experiments/solver-budgets/manifest.json` (hash recorded in
  `identity.json`). Depth 3 (not 4–5) because the pre-run latency probe showed
  depth 4 and 5 exceeding the 200 ms/move budget on this machine.
- 20 frozen seeds, 200 ms/move wall-clock budget, 5,000-move cap, all three
  arms run.

## Replay witness

`60/60 games agree (final-board agreement 100.0%)` — re-simulated from the
committed raw records against the independent reference model.

## Paired outcomes vs the naive baseline (n = 20, bootstrap 95% CI)

| comparison | paired score diff mean | 95% CI | tile reach W/T/L |
|---|---|---|---|
| `native-cpp` vs `naive` | +5108.7 | 4322.5 .. 5902.9 | 20/0/0 |
| `wasm` vs `naive` | +5139.1 | 4340.1 .. 5946.8 | 20/0/0 |

The native-C++ and WASM arms' intervals overlap almost entirely; within this
run they are statistically indistinguishable from each other, and both beat
the naive fallback on every seed. These are machine-specific measurements —
not portable performance claims.

## Per-move latency (wall-clock JS round-trip; includes IPC for native-cpp)

| arm | moves | p50 | p95 | max | over 200 ms budget |
|---|---|---|---|---|---|
| naive | 4,217 | 0.01 ms | 0.03 ms | 1.69 ms | 0 |
| native-cpp | 50,683 | 0.91 ms | 4.92 ms | 44.37 ms | 0 |
| wasm | 50,963 | 0.86 ms | 5.35 ms | 820.99 ms | 2 |

## Control counts

Zero timeouts, fallbacks, rejected-illegal, rejected-no-op, truncated, or
spawn-exhausted games in the naive and native-cpp arms. The wasm arm recorded
**2 timeouts → 2 naive fallbacks** (consistent with its two over-budget
moves); no game was truncated and all 60 games reached game-over.

## What the 200 ms budget bought

At this depth-3 configuration the deep arms did not come close to the budget
(p95 ≈ 5 ms), so the budget functioned as a safety cap rather than a binding
constraint. The score gap (~+5,100) is attributable to the expectimax
strategy versus the naive heuristic, not to time spent. Whether a depth-4
configuration would fit a smaller budget (or score higher under 200 ms) is a
separate question this run does not answer.
