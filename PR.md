# PR.md — burst11-playkit-overlay-extension-run

**Repo:** SamGu-NRX/playkit.ai · **Work branch:** `obv/burst11-playkit-overlay-extension-run` (base `obv/burst11-playkit-overlay-helper-fix` @ `58ba0be`) · **This branch:** `obv-pr/burst11-playkit-overlay-extension-run` (report + evidence) · **Head SHA of code branch:** `7604f56`

## What this burst did

Acted as a user running the shipped MV3 extension end to end in real Chromium: build it, load it unpacked, open a locally served copy of the vendored official 2048 (`gauntlet/bridge/browser/vendor/2048/`, served at a URL path containing `2048`), and drive the full product surface — inject, detect, auto-solve 200+ moves, pause/resume, tab switching, reload, non-2048 isolation, keyboard-only operation — capturing evidence for every journey.

Environment: Playwright Chromium 131 (`chromium-1148`), headed under Xvfb, extension loaded via `--load-extension` from `src/extension/` after a fresh `node scripts/build-phase0.js`. No gauntlet code was modified; the fixture server and journeys live outside the repo.

## Journey results

| # | Journey | Result | Evidence |
|---|---|---|---|
| J1 | Build what the extension needs | `build-phase0` RC=0; regenerated `content.js` is **byte-identical** to the committed bundle (clean `git status`). `build-wasm --release` exits 1: `solver/wasm/export_solver.cpp` does not exist on this base → the WASM solver is not buildable here. | `evidence/j1-build.png` |
| J2 | Install, inject, detect | chrome://extensions shows **"2048 AI Solver" enabled**. HUD mounts (302×544 panel, top-right, shadow DOM). **At load the HUD says "Not detected"** even though the game is fully rendered (see Next packets #1). Manual **Detect Game** attaches `Play2048Adapter` immediately; score panel `-` → `0` matches page. WASM engine: `import()` of `wasm/solver.mjs` **works** from the content script, then fails fetching the never-committed `solver.wasm` → clean JS fallback, HUD shows "Fallback". | `evidence/j2-extensions-page.png`, `j2-page-inject.png`, `j2-detect.png` |
| J3 | Auto-solve 200+ moves, score comparison | Following the README's user path (Detect → Auto-solve): **209 board changes** (≥ 200), zero stuck-random interventions, no game over. Panel score matched the page score at every sample: 4=4, 936=936, 2,264=2,264; final sample read panel `2,376` vs page `2376+16` — the page was mid-merge-animation, normalized page score is 2,376 → **match** (the base's `+N` handling works through the extension path). | `evidence/j3-scores.png`, `j3-solve-mid.png`, `j3-solve-final.png` |
| J4 | Pause / tabs / reload / isolation | **Pause** freezes moves (64 → 64 over 3 s, `Driver stopped`/`Runtime stopped`). **Resume click restarts the driver** (`Driver started`/`Runtime started`). The run then hit a real **"Game over!"** at 66 moves / score 2,980; the extension stopped cleanly and the HUD returned to the stopped state (overlay confirmed on screenshot). **Reload mid-game:** clean teardown (`Runtime destroyed`), HUD re-injects, BEST 2,980 persists via localStorage, detection again needs a manual Detect click. **Non-2048 page:** no HUD, no content-script console at all. Coverage limit: `visibilityState` never flips under Xvfb `bringToFront`, so the visibility auto-pause path was **not** exercised (the tab-away legs measured the already game-over-stopped driver). | `evidence/j4-paused.png`, `j4-resumed.png`, `j4-reload.png`, `j4-tab-away.png`, `j4-plain.png` |
| J5 | Keyboard-only + accessibility | Tab order: 4 page links → **8 HUD controls** → body (HUD naturally reachable). **Enter** on Detect attaches the adapter; **Enter** on Auto-solve starts driving (score ticks up); **Space** stops it. Focus indicator present (`outline: 1px auto`). AX tree exposes named buttons and the `[disabled]` state. Gaps (report-only): three selects have **no label association**; **zero `aria-live`** regions so score/status changes are never announced; collapse button's accessible name is "−" with no expanded/collapsed state. | `evidence/j5-keyboard-focus.png`, `j5-axtree.png` |

## Which solver actually ran

**The JS fallback** (`NaiveSolverEngine`, corner-bias ordering — `src/solver/naive-solver.js:122,160`). Reasons, both evidenced: `solver/wasm/export_solver.cpp` is absent on this base so `build-wasm` cannot run (J1), and the committed half-artifact `src/extension/wasm/solver.mjs` loads but its `solver.wasm` fetch fails, so `SolverManager` falls back (J2 console log). The HUD honestly displays "Fallback".

## In-scope fix (src/extension/)

- `src/extension/README.md`: corrected the bundle-size figures — README claimed `content.js` is "~121 KB uncompressed (~22 KB gzipped)"; measured on this base: **169,416 B (~165 KiB) uncompressed, 31,293 B (~31 KiB) gzipped**. Docs-only change; no test applies (no test infra on this base for docs, and the number is asserted from the measurement above). The rest of the extension path — manifest matching, packaging, mirror, README instructions — ran clean, so no code fixes were required inside `src/extension/`.

Checks run: `node scripts/build-phase0.js` RC=0 after the edit (bundle unchanged, byte-identical to committed). No node test suite exists on this base for `src/` (the tests/ harness arrives via other in-flight PRs).

## Next packets (breaks outside src/extension/ — owned by the base's packet)

1. **One-shot init detection misses live games** — `src/runtime/content-script.js:85` calls `runtime.detectGame()` once at document_idle (autoInit:false at :30); `src/runtime/runtime.js:89,107` never retries. The user sees "Not detected" with Auto-solve disabled while the game is fully rendered; only the separate Detect button recovers. Fix: re-detect on DOM settle / short retry loop.
2. **WASM half-artifact console noise** — `src/extension/wasm/solver.mjs` is committed without `solver.wasm`; every page load logs two `ERR_FILE_NOT_FOUND`, the Emscripten `Aborted(...)` stack, and a caught RuntimeError before falling back (`src/solver/wasm-solver.js:106-110`). Fix: commit the built `solver.wasm` or gate the engine on artifact presence.
3. **Unnamed form controls** — `src/hud/templates.js:277,286,293`: labels for Direction Priority / Solver Strategy / Heuristic have no `for=`, and selects `#direction-priority`, `#solver-strategy`, `#solver-heuristic` have no `aria-label`/`aria-labelledby` (Depth and Probability are labeled correctly — inconsistent).
4. **No live-region announcements** — zero `[aria-live]` nodes in the HUD: score, detection status, and run-state changes are silent to assistive tech; collapse button has accessible name "−" and no `aria-expanded`.
5. **Strategy selector is cosmetic under the fallback** — the HUD offers "Expectimax (Depth)"/heuristic controls, but the fallback's `getMoveOrder` (`src/solver/naive-solver.js:160`) applies fixed corner-bias only; the UI promises strategy the running engine doesn't deliver.

## Handoff

- Merge order: this PR is stacked on `obv/burst11-playkit-overlay-helper-fix` — merge that first.
- Journey scripts, console logs, and raw state JSON live outside the repo (run harness); the evidence PNGs on this branch are the durable record.
- Replay: `node scripts/build-phase0.js`, then load `src/extension/` unpacked, serve the vendored 2048 at any URL containing `2048`, click **Detect Game**, then **Auto-solve**.
