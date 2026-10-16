# Burst 11 — PlayKit 2048 overlay helper: pre-fix reproduction and post-fix verification

Branch under review: `obv/burst11-playkit-overlay-helper-fix` (base `main` @ `870fb89`, head `58ba0be`)
Evidence produced: 2026-10-16, headless Chromium 140 (Playwright) on the vendored 2048 page served locally by `gauntlet/bridge/browser/server.mjs`, using the real `src/bookmarklet/loader.js` bookmarklet with `CDN_URL` pointed at the local server. No harness workarounds (no `Object.prototype` pause/resume shim, no `globalAdapterRegistry` injection).

## Defects

1. **Overlay never initializes in a real browser.** `Runtime.init()` registers the HUD with the VisibilityHandler, which requires `pause()`/`resume()`. The HUD implements neither, so init threw `Error: Component must have pause() and resume() methods`, `window.ai2048Runtime` was never exposed, the panel read "Not detected", Auto-solve stayed disabled, and Detect Game surfaced the failure. Ported from draft PR #1 (`obv/products-playkit-hardening-20261009`, FIX-9) plus a guard so the loop does not reschedule across a pause.
2. **Bare re-exported identifiers in the built bundle.** `scripts/build-phase0.js` compiled `export { X } from "./y.js"` to `exports.X = require(y).X` with no local binding, so `src/adapters/index.js`'s `detectGame()` hitting `globalAdapterRegistry` threw `ReferenceError: globalAdapterRegistry is not defined` in the bundle. Fix: every re-exported alias also gets a `const` local binding. Audited all 38 `export {} from` sites under `src/` (scripted scan): only `globalAdapterRegistry` (adapters/index.js:22,39) is used bare in code; no module declares or imports a colliding name.
3. **Panel score inflated during score animations.** `Play2048Adapter.getScore()` read `.score-container`'s `textContent`, which the game transiently decorates with a `.score-addition` child (`+8`); `"2428+8"` → non-digit strip → `24288`. Fix: clone the container, drop `.score-addition` nodes, parse the element's own text.

4. **VisibilityHandler never actually managed the HUD** (consequence of 1): after the fix the HUD registers, `hud.visibilityPaused` flips with the page state, and hiding the tab pauses the driver (`driver.isPaused=true`), showing it resumes.

## Contract tests (external, `test/` on this branch)

Node built-in test runner + jsdom; 9 tests. Fail-first verified against the unfixed tree, green against the fix:

| # | Test | Pre-fix | Post-fix |
|---|------|---------|----------|
| 1 | bundler: a re-exported name also gets a local binding usable inside the module | fail | pass |
| 2 | bundler: re-exports keep their external exports | pass | pass |
| 3 | the repo's real bookmarklet bundle has no bare re-exported identifier left | fail | pass |
| 4 | Runtime can register the HUD with the VisibilityHandler | fail (`Component must have pause() and resume() methods`) | pass |
| 5 | HUD.pause() stops its update-loop timer; resume() restarts it when the fallback loop was running | fail (`hud.pause is not a function`) | pass |
| 6 | HUD.resume() must not restart the loop when auto-solve was not running | fail (`hud.pause is not a function`) | pass |
| 7 | a page hidden at registration pauses the HUD; showing it again resumes | fail (`Component must have pause() and resume() methods`) | pass |
| 8 | getScore ignores a live .score-addition during a +8 animation | fail (24288 ≠ 2428) | pass |
| 9 | getScore still reads the page score with no addition element | pass | pass |

Full fail-first run: `failfirst-full.txt` (7 fail / 2 pass). Post-fix run: `testspass.txt` (9/9).

## Pre-fix reproduction (evidence/01–05)

Real bookmarklet pasted on the vendored page, no fixes:

- `01-prefix-page-loaded.png` — game loaded, tiles rendered.
- `02-prefix-panel-not-detected.png` — panel shows "Not detected", Auto-solve disabled.
- `03-prefix-detect-error.png` — after Detect Game click, still not detected.
- `04-prefix-score-inflation.png` — with a live `.score-addition` (+8) child, page score 0 read as 8; `"2428+8"` → 24288.
- `05-prefix-console.png` — browser console: `Component must have pause() and resume() methods`, `ReferenceError: globalAdapterRegistry is not defined`.
- `prefix-results.json` — machine-readable state.

## Post-fix user run (evidence/06–13, run twice: at 65dd865 and at PR head 58ba0be)

Same real-bookmarklet setup, exercising the product UX:

- Paste → runtime initializes, `window.ai2048Runtime` present (`06-postfix-panel-detected.png`: Game: Play2048Adapter, Auto-solve enabled).
- Auto-solve starts on paste: 11 moves without touching anything (`07-postfix-autosolve-running.png`).
- HUD Auto-solve button toggles: press → moves freeze; press again → plays on to 120+ (a game that ended early is retried via the game's own Try again, as a user would).
- Stop → panel score equals the page score exactly (`08-postfix-final-score.png`, `09-postfix-score-check.png`: page SCORE 2480 = panel 2,480 in one run; 2516 and 2440 in the other two runs — always equal).
- Hide the tab (visibilitychange → hidden): moves frozen over 4 s, `hud.visibilityPaused=true`, `driver.isPaused=true` (`10-postfix-hidden-paused.png`); show it again: moves resume (`11-postfix-shown-resumed.png`, `12-postfix-visibility-check.png`).
- `13-postfix-console.png` — clean console for the full run apart from one pre-existing `404 /2048/solver.mjs` (the WASM solver's dynamic import resolves relative to the page URL; SolverManager falls back to the naive engine — flagged in the PR, out of scope here).
- `postfix-results.json` — machine-readable results of the head run.

## Repo test suite

`node --test gauntlet/` at head `58ba0be`: 331 tests — 303 pass, 25 fail, 3 skipped. All 25 failures were verified pre-existing: the same suites (bridge e2e, chess/stockfish, python client, CLI e2e, registry conformance, elo, runner, trajectory) fail identically at the clean base `870fb89` (checked out in a scratch worktree; e.g. the four suspect suites fail 4/4 there). They are environment gaps (engine binaries, python client), untouched by this diff.

## How to re-run

```bash
# contract tests (external)
cd <this branch>/test && npm i jsdom && node --test .
# pre-fix repro / post-fix user run (expects playwright + chromium)
node repro.mjs   # on the unfixed tree
node userrun.mjs # on the fixed tree
```
