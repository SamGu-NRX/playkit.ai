# Browser Benchmark — Runtime Plays the Board It Observes

Evidence harness for the question at the center of the hardening audit: **does
the extension actually play the board the human is looking at, every time?**

It runs the real code (adapters → runtime → solver → driver) inside fixture
pages served over HTTP, in three layers:

| Layer | What runs | What it proves |
|---|---|---|
| 1 | Node unit tests (`test/`) | Engine/rules-level correctness |
| 2 | **src modules** loaded directly in fixture pages | Adapter + runtime behavior on real DOM, real events |
| 3 | **the built `src/extension/content.js`** (shimmed `chrome.*`) | The exact shipped artifact behaves the same way |

Layer 2 without Layer 3 can pass while the shipped bundle is broken (or vice
versa). The `bundle-*` scenarios keep them honest.

## Run it

```sh
node scripts/serve-bench.mjs 8765
# open http://localhost:8765/bench/runner.html and click "Run all scenarios"
```

"Save results JSON" writes `bench/results/run-<timestamp>.json` and
`bench/results/last-run.json` via `POST /api/results`.

### Standalone fixture URLs

Every fixture page is directly openable and parameterized:

- `bench/fixtures/play2048-style.html` — play2048.co-like DOM (`.tile-container`,
  `.tile`, `.tile-position-{COL}-{ROW}` 1-based, `.game-container.game-over`)
- `bench/fixtures/generic-grid.html` — 16 numeric cells in `#game-board`
- `bench/fixtures/getmit-style.html` — GetMIT-style `.cell-{COL}-{ROW}` rows

Query parameters: `seed`, `scenario` (`normal|late|gameover|swap`),
`listener` (`document|window|element`), `keyProp` (`key|which|keyCode`),
`touchOnly=1`, `customListener=1`, `layer` (`src|bundle`), `wasm`
(`missing|mock|off`), `adapter` (`auto|play2048|generic|getmit`), `hud=0|1`,
`autoStart=0|1`.

`window.__BENCH__` on any fixture page exposes `adapterBoard()`,
`engineBoard()`, `logs()`, `runtime()`, `timeMoveOrder()`, and more for
one-off inspection from the console.

## Scenarios and what each one is for

| Scenario | Target failure mode |
|---|---|
| `input-play2048{,-which,-keycode}` | Keys ignored because the page reads `e.which`/`e.keyCode` or hangs the listener on `window`/an element |
| `input-generic` | Baseline dispatch → move on a no-special-cases page |
| `input-getmit` | GetMIT-style boards: position-class parsing parity + custom-event move path |
| `touch-generic` | Touch-only pages (`touchOnly=1`): swipes must produce moves |
| `late-play2048` | Game renders late; detection ran too early → adapter never attaches |
| `autostart-generic-late` | Driver starts on a page whose board appears late; driver must re-detect, not press on a null board |
| `gameover-generic` | Game over state: no driver presses should be dispatched on a dead board (FIX-5) |
| `vanish-play2048` | Board container removed from DOM: presses must stop (FIX-5) and reads must not go stale (FIX-7) |
| `swap-generic` | Site re-renders a fresh game in place (seed swap); detection must re-attach and logs must reset (FIX-6) |
| `wasm-missing-play2048` | `solver.wasm` absent (fresh checkout): fallback path, no crash |
| `wasm-mock-play2048` | Mock ES module substituted through `moduleUrl`: the full WASM loading contract works |
| `bundle-play2048` | Same scenarios through the built bundle |
| `bundle-wasm-mock-play2048` | Bundle + mocked WASM through the production `chrome.runtime.getURL` path |
| `adapter-getmit-direct` | Forced `GetMITAdapter` on a GetMIT-shaped page |

## Metrics

Per scenario: `inputCount` (every keydown/touch/custom event, deduped across
listener levels), `moveCount` (engine-applied moves), `parity` (adapter board
== engine board after the script), `moveOrderMs` (solver `getMoveOrder`
latency), `ignoredKeydowns`, and solver status (engine type, ready, lastError).

### Reading the numbers

- `inputCount` ≫ `presses` — event duplication (multiple listener levels /
  double dispatch). `inputCount` < `presses` — keys silently swallowed.
- `parity=false` — the extension would press on a board the human is not
  seeing. This is the headline metric.
- `moveCount` = 0 with presses on a dead/vanished page is correct **after**
  FIX-5 and a bug before it.
- `moveOrderMs` tens-of-ms vs sub-ms distinguishes WASM from naive fallback.

## Known limitations

- `dispatchKeyboard` constructs `KeyboardEvent`s; `which`/`keyCode` are
  read-only on constructed events. Chromium derives them from `key` for arrow
  keys, so the `keyProp` scenarios are valid there but are not a synthetic
  legacy-IE simulation.
- Real WASM (`solver.wasm`) is not committed; `wasm=missing` measures the
  fallback path and `wasm=mock` proves the loading contract. The binary itself
  is not exercised in this environment.
- Touch swipes are synthesized `TouchEvent`s, not CDP input events. Headless
  Chromium may lack `Touch` constructors; the scenario notes it and degrades
  honestly.
- The fixture engine is deliberately independent of `src/` (re-implemented
  rules + seeded spawns) so parity checks compare two implementations rather
  than a thing with itself.

## Extending

Add a scenario to `SCENARIOS` in `bench/harness.js` (fixture + params + a
small step script), add a row automatically, done. Fixture pages only need a
`window.__createFixtureGame` factory with an `onRender` drawing into the page's
DOM — see `bench/fixtures/game-engine.js` for the shared engine contract.
