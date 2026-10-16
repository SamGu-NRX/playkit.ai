# PlayKit overlay: the 2048 helper finds the game on its own

**Status: DRAFT — verification complete on this branch; open for review, do not merge autonomously.**
**Branch:** `obv/burst12-playkit-overlay-autodetect` · **Head:** `8cf9fcb` (`feat(runtime): auto-detect the game with bounded DOM-mutation retries`) · **Base:** `alpha` (follow-up to #58)
**Author:** Human author: Sam Gu (sgu07966@gmail.com) — work driven by Obvious Autobuild on the repo sandbox.

---

## 1. Problem

PR #58 left one blocker on the overlay extension: **the HUD said "Not detected" every time the page loaded until the user clicked Detect Game manually.** The cause is an initialization race in the vendored 2048 page: its tiles are created inside a `requestAnimationFrame` callback that runs *after* the content script's one-shot detection at `document_idle`. Detection requires at least one `.tile` on the board, so at init time the probe always ran too early, and nothing ever retried. The same race hits the bookmarklet path.

PR #58's second gap: the visibility pause/resume leg was never exercised because tab visibility did not flip in the prior run's environment.

## 2. Fix (commit `8cf9fcb`)

- **`src/observer/detection-watcher.js` (new)** — `DetectionWatcher`: bounded re-detection helper. It re-runs the detection callback on *debounced* DOM mutations plus a periodic heartbeat, and hard-stops after a configurable window (default **15 s**) or as soon as an adapter attaches. Debounce window 250 ms; detached on `pagehide` and on watcher stop.
- **`src/runtime/runtime.js`** — `Runtime` starts the watcher during init when no game is present, and stops it the moment an adapter attaches (one-shot path unchanged: a game present at init is still detected immediately). Watcher is stopped in `destroy()`.
- **`src/runtime/content-script.js`** — extension mode explicitly passes `autoInit: false` (unchanged semantics: detection wires components, never auto-starts solving). Bookmarklet `autoInit: true` parity falls out of the same watcher: late attach wires the HUD and enables Auto-solve without starting it.
- **`src/test/autodetect.test.mjs` (new)** — 4 jsdom tests: late markup (500 ms) detected without a click; probe stops after the bounded window; game present at init still detected by the one-shot path; rapid mutations debounced into few probes.
- Test dep `jsdom@24` was installed **outside the repository** (`/home/user/work/node_modules`); no repo dependency changes.
- Per wave constraints, the rebuilt bundle (`src/extension/content.js`) is intentionally **not committed**; `scripts/build-phase0.js` regenerates it and was verified **byte-identical across two consecutive builds** (sha256 `4d9c9a17…`).

## 3. Verification — real Chromium, headed, under Xvfb

Environment: Playwright `1.49.1`, Chromium **131.0.6778.33** (build v1148 — the same build as #58), headed (`headless:false`) under `Xvfb :99` on the repo sandbox; fixture server from `gauntlet/bridge/browser/server.mjs` (same harness as #58); profile contexts loaded the unpacked extension from `src/extension/` with the rebuilt bundle. Details: `evidence/env-setup.png`, build/diff: `evidence/j1-build.png`.

### 3.1 Fail-first unit test (red → green)

Pre-fix worktree (`8cf9fcb~1` + the new test file): **3 pass / 1 fail** — `not ok 1 - game markup inserted 500 ms after init is detected without a click … adapter attached after late markup`. Post-fix (`8cf9fcb`): **4/4 pass**. `evidence/test-fail-first.png`.

### 3.2 Extension repro and fix

| Leg | Pre-fix | Post-fix |
|---|---|---|
| Load `/2048/`, no clicks | HUD **"Not detected"**, Auto-solve **disabled** (`evidence/repro-extension-notdetected.png`) | HUD **"Game: Play2048Adapter"**, Auto-solve **enabled**, detected in **~0.4 s** of page time (`evidence/fix-extension-detected-at-load.png`) |

Console during late detection (new path live): `No game detected` → `Runtime: no game detected yet; retrying on DOM changes for up to 15000ms` → `AdapterRegistry: Selected Play2048Adapter` → `Game detected: Play2048Adapter` → `GameMutationObserver started on DIV.game-container` → `Components set up successfully`.

### 3.3 J2 — extension loads

`chrome://extensions` shows the "2048 AI Solver" card loaded and enabled (`evidence/j2-extensions.png`).

### 3.4 J3 — auto-solve drives the game

After one click of Auto-solve: **243 real board-state changes in ~12.6 s** (main-world DOM watcher counting genuine tile-state changes; animation-only classes stripped), crossing the ≥200 bar. Page score climbed 0 → 692 while the HUD panel score tracked it (680 + in-flight addends, matching the +N animation lag #58 saw). `evidence/j3-solve-mid.png`, `evidence/j3-solve-final.png`. Sample trail: 44 @2.5s → 97 → 142 → 192 → 243 @12.6s.

### 3.5 J4 — pause, visibility, reload, isolation

- **Pause/Resume:** stopping froze the board (245 changes → 245 after 2 s, score static); resuming grew it again (245 → 312, score 1076). `evidence/j4-paused.png`.
- **Visibility pause/resume:** *partial — see §5.* In a final targeted run the extension logged `VisibilityHandler: Page hidden` in a real headed browser when the tab actually lost visibility — the handler wiring engages. However the flip's timing under Xvfb + synthetic input was not reproducible reliably enough to capture a frozen-board sequence. Best captured frames: `evidence/j4-visibility-hidden.png`, `evidence/j4-visibility-resumed.png`.
- **Reload mid-game:** after `reload()`, the HUD re-mounted and **auto-detected with no click** (`status: "Play2048Adapter"`, Auto-solve enabled) — under the pre-fix code this required another manual Detect. `evidence/j4-reload.png`.
- **Non-2048 isolation:** on the fixture server root (no `2048` in URL): no HUD host, no `ai2048Runtime` side effects (`hud:false, runtime:false`). `evidence/j4-plain.png`.

### 3.6 Bookmarklet path

Injected the bundle at `DOMContentLoaded` (the earliest real bookmarklet timing, before the game's first rAF frame):

- **Pre-fix:** HUD shows **"Not detected"**, Auto-solve disabled — the race reproduces. `evidence/repro-bookmarklet-notdetected.png`.
- **Post-fix:** the watcher retries on the game's first DOM mutation and the HUD shows **"Game: Play2048Adapter"** with Auto-solve **enabled** and the solver **not** started (autoInit parity with the extension path). `evidence/fix-bookmarklet-detected.png`.

## 4. Honest deltas vs the task list

- **200+ moves with score comparison:** done — 243 board changes, page score 692 vs HUD 680 (in-flight +N addend lag; consistent with #58's observation). Driven by the fallback JS solver: the WASM solver fails to fetch under `chrome-extension://` in this environment (`SolverManager: WASM initialization failed, using fallback`) — a known constraint, orthogonal to detection.
- **Visibility pause/resume:** NOT fully captured (below). Handler engagement evidenced by console; frozen/resumed board sequence not.
- **Bookmarklet "Not detected" repro** is timed at DOMContentLoaded injection — the earliest legitimate user moment; a later click past first paint would already see tiles and would not reproduce (pre-fix one-shot detection succeeds there). This is the worst case, which is the one that matters.

## 5. What blocked the visibility flip, and what was tried

Environment: Chromium 131 headed under Xvfb (no window manager). Attempted, in order:

1. **`page.bringToFront()` (CDP `Page.bringToFront`)** — `document.visibilityState` stayed `visible` on the backgrounded tab. Reproduces #58's finding.
2. **Removing Playwright's default occlusion-suppressing flags** (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` via `ignoreDefaultArgs`) — no change.
3. **`chrome.tabs.update` via the extension's service worker** — impossible: the overlay is a pure MV3 content script with **no** background worker (`manifest.json` has no `background` key).
4. **Real X11 keystrokes (`xdotool` Ctrl+Tab)** — the flip *does* engage: the extension logged `VisibilityHandler: Page hidden` (captured twice in separate runs), but it fired seconds after the keystroke and unreliably relative to sampling, so a clean frozen→resumed board sequence could not be captured within the run budget.

Conclusion: the wiring is real (console-verified in a real browser) but the environment cannot deterministically drive tab occlusion. **Next packets:** (a) drive occlusion via a real WM (openbox) or CDP `Page.setWebLifecycleState` to capture the frozen/resumed board; (b) exercise the WASM solver path in a served (non-extension) context to close that verification gap.

## 6. Acceptance criteria status

| Criterion | Status |
|---|---|
| Extension HUD shows "Game: Play2048Adapter" at page load, no clicks | ✅ `fix-extension-detected-at-load.png` |
| Bookmarklet path detects late game without click | ✅ `fix-bookmarklet-detected.png` (pre-fix repro: `repro-bookmarklet-notdetected.png`) |
| Fail-first test then 4/4 | ✅ `test-fail-first.png` |
| J2 extension load | ✅ `j2-extensions.png` |
| J3 auto-solve ≥200 moves + score comparison | ✅ 243 changes, scores tracked (`j3-solve-*.png`) |
| J4 pause/resume | ✅ `j4-paused.png` |
| J4 tab-visibility pause/resume | ⚠️ console-verified; board sequence not capturable in this environment (§5) |
| J4 reload re-detection (new behavior) | ✅ `j4-reload.png` |
| J4 non-2048 isolation | ✅ `j4-plain.png` |
| Bundle reproducible, rebuilt bundle uncommitted | ✅ sha256-identical builds; bundle not in the commit |

## 7. Evidence index (15 files, `evidence/`)

`env-setup.png` · `j1-build.png` · `test-fail-first.png` · `repro-extension-notdetected.png` · `fix-extension-detected-at-load.png` · `j2-extensions.png` · `j3-solve-mid.png` · `j3-solve-final.png` · `j4-paused.png` · `j4-visibility-hidden.png` · `j4-visibility-resumed.png` · `j4-reload.png` · `j4-plain.png` · `repro-bookmarklet-notdetected.png` · `fix-bookmarklet-detected.png`

## 8. Merge notes

Per standing rules this PR is **not merged autonomously** — it targets `alpha` (not the default branch) but the human makes all merges. Suggested merge command when ready:

```bash
gh pr merge <PR-number> --repo SamGu-NRX/playkit.ai --squash
```

---
🔗 [Obvious Project](https://app.obvious.ai/p/agent-tools-PQyawTQb) · 🧵 [Obvious Thread](https://app.obvious.ai/p/agent-tools-PQyawTQb?thread=th_aQcOAK9Y) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/playkit-overlay-the-2048-helper-finds-the-game-on-task:todo_pb91d27k)
