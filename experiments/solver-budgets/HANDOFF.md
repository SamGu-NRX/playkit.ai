# Handoff — solver-budgets study

Status as of 2026-10-10: **complete and measured**. Branch
`obv/products-l2-solver-budgets-20261010` (based on
`obv/products-playkit-hardening-20261009`).

## What is here

- `manifest.json` — 3 arms (naive, native-cpp, wasm), 20 frozen seeds,
  200 ms/move budget, 5,000-move cap, depth 3 with recorded rationale.
- `spawn-history.json` — frozen per-seed spawn streams, generated before any
  arm was evaluated.
- `lib/` — engine bindings (naive / native-cpp shim / WASM embind / scripted),
  runner, replay verifier, paired bootstrap analysis, identity recorder.
- `native/` — persistent shim source + build script (stages submodule headers
  with a Linux/g++ compatibility patch applied only in the build dir).
- `wasm/build-wasm-study.sh` — Emscripten build of the same C++ sources
  (`-sENVIRONMENT=web,node`; the web-only glue cannot load the wasm binary
  from Node). Requires emsdk; stages a header-only sparsehash copy.
- `tests/` — runner semantics, native convention cross-check, replay
  verification. All pass.
- `results/RUN.md` + `results/run-2026-10-10T20-34-13-618Z/` — the measured
  run: replay 60/60 agree; both deep arms beat naive by ~+5,100 paired score
  (tight CIs, 20/0/0 tile reach); latency p95 ≈ 5 ms for the deep arms; 2
  wasm timeouts → 2 naive fallbacks; `identity.json` pins provenance.

## How to resume / rerun

```bash
source ~/emsdk/emsdk_env.sh   # if the WASM arm should be included
bash experiments/solver-budgets/native/build-native.sh
bash experiments/solver-budgets/wasm/build-wasm-study.sh
node experiments/solver-budgets/run.mjs --manifest experiments/solver-budgets/manifest.json
node experiments/solver-budgets/run.mjs --replay   <run-dir>
node experiments/solver-budgets/run.mjs --analyze  <run-dir>
node --test experiments/solver-budgets/tests/
```

Then point `results/RUN.md` at the new run dir. Changing the budget, cap, or
seeds invalidates comparability with the committed run.

## Constraints honored

No edits to `src/`, the `2048-solver` submodule, or the browser benchmark.
Draft PR only; nothing merged or deployed.
