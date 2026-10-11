# Handoff — solver-budgets study

Status as of 2026-10-11: **complete and measured — four-arm run including the
actual production adapter**. Branch
`obv/products-l2-solver-budgets-20261010` (based on
`obv/products-playkit-hardening-20261009`).

## What is here

- `manifest.json` — 3 arms (naive, native-cpp, wasm), 20 frozen seeds,
  200 ms/move budget, 5,000-move cap, depth 3 with recorded rationale.
- `manifest-adapter.json` — the same manifest plus the `adapter` arm: the
  ACTUAL production orchestration path (`src/solver/solver-manager.js`
  `SolverManager` — ensureBoard normalization, engine dispatch, wasm→naive
  declared fallback) exactly as the extension runtime constructs it, at the
  same depth-3 strategy. Board state still advances only through the
  independent reference model; the adapter only ever translates a board
  into a preferred move order, and every move records `meta.engine` and
  `meta.managerStatus`.
- `spawn-history.json` — frozen per-seed spawn streams, generated before any
  arm was evaluated.
- `lib/` — engine bindings (naive / native-cpp shim / WASM embind / scripted
  / `adapter-binding.mjs` for SolverManager), runner, replay verifier,
  paired bootstrap analysis, identity recorder. Standard 2048 merge scoring
  via the reference model's `moveGain` (never tile sums).
- `native/` — persistent shim source + build script (stages submodule headers
  with a Linux/g++ compatibility patch applied only in the build dir).
- `wasm/build-wasm-study.sh` — Emscripten build of the same C++ sources
  (`-sENVIRONMENT=web,node`; the web-only glue cannot load the wasm binary
  from Node). Requires emsdk; stages a header-only sparsehash copy.
- `tests/` — runner semantics, native convention cross-check, replay
  verification, scoring. All pass (17).
- `results/RUN.md` + `results/run-2026-10-11T01-59-11-757Z/` — the measured
  run: **four arms ran, none unavailable**; replay **80/80 agree**; the
  adapter arm reproduced the naive arm's games **move-for-move (paired
  diff exactly 0.0, tile reach 0/20/0)** — the strongest possible replay
  witness for the production path; native-cpp and wasm each beat naive by
  ~+50,793 paired score (standard merge scoring; **not comparable with the
  earlier tile-sum run** run-2026-10-10T20-34-13-618Z, kept in results/).
  Zero timeouts, fallbacks, rejections, or truncations in all four arms;
  `identity.json` pins provenance.

## How to resume / rerun

```bash
source ~/emsdk/emsdk_env.sh   # if the WASM arm should be included
bash experiments/solver-budgets/native/build-native.sh
bash experiments/solver-budgets/wasm/build-wasm-study.sh
node experiments/solver-budgets/run.mjs --manifest experiments/solver-budgets/manifest-adapter.json
node experiments/solver-budgets/run.mjs --replay   <run-dir>
node experiments/solver-budgets/run.mjs --analyze  <run-dir>
node --test experiments/solver-budgets/tests/
```

`--replay` must print `agree` for every arm with final-board agreement
100.0%; `--analyze` marks any arm with an over-budget move
failed/unavailable and excludes it from paired comparisons, and `run.mjs`
records any arm that fails to build or start in `armsNotRun` with its
reason — arms are never estimated or silently dropped. Then point
`results/RUN.md` at the new run dir. Changing the budget, cap, seeds, or
scoring invalidates comparability with the committed run.

## Constraints honored

No edits to `src/`, the `2048-solver` submodule, or the browser benchmark.
Draft PR only; nothing merged or deployed.
