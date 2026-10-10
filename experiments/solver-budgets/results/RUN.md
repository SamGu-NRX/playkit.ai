# Latest run — 2026-10-10T20-34-13-618Z

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
