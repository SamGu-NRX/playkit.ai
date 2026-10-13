# Browser-benchmark baseline (pre-fix state)

Recorded 2026-10-10. Baseline branch point: `76f059e` (bench foundation +
FIX-8 adapter-registry fix + console capture), with the two test branches
merged (this document's commit). The fixture engine and bench foundation are
kept exactly as committed — these are the observed numbers, not adjusted ones.

## Exact harness invocation

```sh
node --test test/*.test.mjs          # Node v20.20.2, zero deps, no package.json
node scripts/build-phase0.js         # rebuild bundle; verify zero src diff at baseline
node scripts/serve-bench.mjs 8765    # static server + POST /api/results sink
# then open http://localhost:8765/bench/runner.html and press "Run all scenarios"
# "Save results JSON" writes bench/results/last-run.json (+ run-<timestamp>.json)
```

## Node suite baseline

`node --test test/*.test.mjs` → **60 tests: 53 pass, 7 skipped, 0 fail** (~1.2 s).
Skips carry `TODO(FIX-n)` markers (FIX-1 encoder values-only contract,
FIX-2 dead-board `[]` contract, FIX-3 engine attribution / getBoardInfo null).
Build at baseline: `node scripts/build-phase0.js` produces **no src diff**
(checked-in bundle matches sources).

## Browser suite baseline (bench/results/run-2026-10-09T21-56-29-525Z.json)

16 scenarios — **13 ok, 2 errors, 1 parity mismatch.**

| Scenario | detect | inputs→moves | parity | note |
|---|---|---|---|---|
| input-play2048 | Play2048Adapter | 5→5 | ✓ | getMoveOrder 1.5 ms |
| input-play2048-which | Play2048Adapter | 5→0 | ✓ | which-only events register as input but the game applies none |
| input-play2048-keycode | Play2048Adapter | 5→0 | ✓ | same for keyCode-only events |
| input-generic | GenericAdapter | 5→5 | ✓ | |
| input-getmit | GenericAdapter | 5→5 | ✓ | hostname gate resolves to Generic; forced GetMIT scenario passes |
| touch-generic | GenericAdapter | touches=5→0 | ✓ | TouchEvent dispatch unsupported in headless env (environment limitation, not a product defect) |
| late-play2048 | Play2048Adapter | 5→5 | ✓ | detection works after late board mount |
| autostart-generic-late | GenericAdapter | 160→88 (48 ignored) | ✓ | 8 s driver run, parity held |
| gameover-generic | GenericAdapter | 105→0 (84 ignored) | ✓ | **unbounded driver activity on a dead board: 105 synthetic events in ~3 s, zero effect** |
| vanish-play2048 | Play2048Adapter | 10→3 (7 ignored) | **✗** | **adapterBoard reads an all-zero board after the board container is removed while the engine holds real state** |
| swap-generic | GenericAdapter | 10→6 | ✓ | replacement-board re-detection worked on this path |
| wasm-missing-play2048 | Play2048Adapter | 5→5 | ✓ | falls back cleanly when solver.mjs import fails |
| wasm-mock-play2048 | Play2048Adapter | 5→5 | ✓ | mock loads via dynamic import; mode "wasm", status "ready" |
| bundle-play2048 | — | — | — | **Error: timeout waiting for bundle runtime** |
| bundle-wasm-mock-play2048 | — | — | — | same |
| adapter-getmit-direct | GenericAdapter | 5→5 | ✓ | |

## Browser-console failures captured (bundle fixtures)

Via the bootstrap console capture (`window.__BENCH_CONSOLE__`), the built
content script fails init with:

```
Runtime initialization failed: Error: Component must have pause() and resume() methods
    at VisibilityHandler.addManagedComponent (src/extension/content.js:3896)
    at Runtime.init (src/extension/content.js:4362)
    at initRuntime (src/extension/content.js:4757)
    at main (src/extension/content.js:4150)
2048 AI Solver: Content script initialization failed: <same error>
```

The layering is the diagnostic: the src-module layer (Layer 2) was exercised
with `enableVisibilityHandling: false` and works; the shipped content-script
path (Layer 3) passes `enableVisibilityHandling: true` and dies inside
`Runtime.init`, so `window.ai2048Runtime` is never assigned and the whole
extension is inert. Fixed earlier in this branch (FIX-8, commit `c77642d`):
`src/adapters/index.js` re-exported `globalAdapterRegistry` without importing
it, so `detectGame()` threw `ReferenceError` outside the bundler.

## What the baseline demonstrates

1. **Bundle init crash (new):** the visibility-handler contract
   (`pause`/`resume` required) is violated during `Runtime.init` → shipped
   extension never initializes.
2. **Vanish/zero-board read (parity ✗):** adapters keep returning a
   fabricated all-zero board after the board DOM is removed; anything acting
   on that observation (naive solver, WASM, driver) is acting on fiction.
3. **Dead-board behavior:** the driver keeps dispatching indefinitely
   (105 events / 3 s) when moves stop changing the board — no bounded
   retries, no stop.
4. Controls: which/keyCode-only synthetic events and TouchEvent dispatch
   define the honest limits of what this environment can exercise.

Upstream reach-rate claims are not measurements of this extension; the
reach counts in `bench/results/*.json` are the only numbers this repo
produces about itself.

## Post-fix run (2026-10-10)

All five findings have fixes on this branch, verified by the same harness:

| Baseline finding | Fix | Verification |
|---|---|---|
| Bundle init crash | HUD now implements `pause()`/`resume()` (visibility-handler contract) | `bundle-play2048`, `bundle-wasm-mock-play2048` pass |
| Vanish/zero-board read | `Play2048Adapter.readBoard` reports `null` when board structure is unobservable; generic-adapter DOM cache entries invalidated when their container detaches | `vanish-play2048` parity ✓; `test/board-observation.test.mjs` |
| Dead-board driving | Driver counts consecutive no-progress ticks (`maxNoProgressTicks`, default 20) and stops with a reason + one `onError`; failed board reads stop after `maxRetries`; empty solver order is game over, not "press all four" | `gameover-generic` pass; `test/driver-bounds.test.mjs`, unskipped FIX-2/FIX-5/FIX-5b contracts in `test/driver.test.mjs` |

Node suite after the fixes: **69 pass, 0 fail, 4 skips** — the skips are the
real-WASM solver-stack tests (`solver.wasm` is gitignored and `emcc` is
unavailable here; fallback and mock-WASM paths are covered).

Browser run after the fixes: **16/16 scenarios pass** — evidence in
`bench/evidence/postfix-run.json` (same 16-scenario harness as the baseline;
bundle scenarios run the built `src/extension/content.js`).


## Contract-bundle run (2026-10-11, encoding-contract commit d73a4e9)

Re-run after the FIX-1 contract landed (`bench/evidence/encoding-contract-run.json`):
16/16 scenarios pass in a real headless browser against the rebuilt
`src/extension/content.js` bundle. The contract made no valid-board behavior
change — only previously ambiguous/invalid inputs now fail fast.
