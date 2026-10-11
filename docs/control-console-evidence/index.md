# Control console HUD — milestone 3 browser evidence

Walk of the witness-driven HUD running the **built bundle** (`layer=bundle`) on the
play2048-style bench fixture, with the WASM-missing route (`wasm=missing`) so the
solver shows its real fallback behavior, and `autoStart=1&seed=7` for a
deterministic driver run. Captures are named `tc-N-*`.

## Reproduce

```bash
python3 -m http.server 8949 --bind 127.0.0.1   # from the repo root
agent-browser open "http://127.0.0.1:8949/bench/fixtures/play2048-style.html?layer=bundle&hud=1&autoStart=1&wasm=missing&seed=7"
```

State was read with `agent-browser eval` against the open shadow root
(`document.getElementById('ai-2048-solver-hud').shadowRoot`); screenshots with
`agent-browser screenshot`. The fixture exposes `window.__BENCH__.logs()`
(input log, move log, ignored keydowns) used for the keyboard-leak check.

## Captures

| File | Shows |
| --- | --- |
| `tc-1-desktop-1440x900.png` | HUD mounted over the live game; driver running (toggle reads "⏹ Stop"); solver status `Fallback` with the verbatim WASM fetch failure as the tooltip; live `score` ticking. |
| `tc-2-gameover-selfstop.png` | Deterministic run reached game over; the driver self-stopped and the HUD surfaced it: problem row "Game over: game over", run toggle back to "▶️ Auto-solve", pause disabled, retry hidden (game-over prescribes a new game, not a retry). Button green is the contrast-fixed `rgba(21,128,61,0.9)`. |
| `tc-3-escape-collapsed.png` | After pressing Escape with focus inside the HUD: panel collapsed (`data-collapsed="true"`), `aria-expanded="false"`, label "Expand panel", and focus returned to the last host-page element (verified `focusReturnedToHost: true` in the same state). |
| `tc-4-reclamp-800x600.png` | Viewport shrunk to 800×600: the panel re-clamps fully into view (rect 302×586, right ≤ viewport, top clamped to 0) with internal scrolling (`overflow-y: auto`, `max-height: calc(100vh - 16px)`). |
| `tc-5-reduced-motion.png` | With `prefers-reduced-motion: reduce` emulated: computed `transition-duration` is `0s` on the panel and buttons (the reduced-motion block's `transition: none !important` wins). |
| `tc-6-keyboard-move.png` | Header focused, ArrowLeft pressed: panel moved 1120px → 1104px (16px step; Shift = 64px), focus retained, and the key did not reach the host game (see keyboard checks). |

## Keyboard checks (measured, via `window.__BENCH__.logs()`)

- **Game keys reach the game with the HUD mounted.** ArrowLeft with focus on a
  host-page element: the fixture's input log advanced (195 → 196). The HUD
  captures nothing globally.
- **HUD keys do not leak into the host game.** ArrowLeft with the header
  focused: the panel moved and the game's own key handler never saw the key
  (`ignoredKeydowns` unchanged). This required a fix — handled keys now call
  `stopPropagation()` (header movement keys and consumed Escape; unhandled keys
  such as Tab pass through).

## Fixes found by this walk (all in the final bundle)

1. **Focus return was silently dead.** `handleDocumentFocusIn` tested
   `shadowRoot.contains(event.target)`, but focus events originating inside the
   shadow tree are retargeted at the boundary — their document-level target is
   the shadow host itself, so the listener recorded the HUD host div as the
   "last host element" and Escape returned focus nowhere. Fixed with
   `composedPath()`; regression test added.
2. **Focus-return ordering.** Collapsing first parked focus on the shadow host
   (invalid-focus state), where this Chrome refused further programmatic focus.
   The handler now returns focus to the host page *before* collapsing, with a
   350 ms re-assert after the collapse transition as a safety net.
3. **Short viewports.** The 800×600 re-clamp left the panel bottom (633px)
   below the fold; added `max-height: calc(100vh - 16px)` + `overflow-y: auto`
   (measured 586px, fully in view, scrollable).
4. **Contrast.** axe flagged the Auto-solve button: white on
   `rgba(34,197,94,0.8)` over the dark panel ≈ 2.1:1 (serious). Darkened to
   green-700 at 0.9 alpha ≈ 5.9:1 composite; it disappeared from the rescan.
5. **Key leakage.** Handled HUD keys propagated to the host page (see keyboard
   checks); fixed with `stopPropagation()` on consumed keys.

## axe scan (`axe-scan.json`)

axe-core 4.10.2, rule set wcag2a/2aa/21a/21aa, run with the HUD on and off:

- With HUD: `color-contrast` (serious) on `.bench-banner`, `#fixture-script-info`,
  `.score`, `.tile-inner` ×2 — the fixture page's own 2048 chrome.
- Without HUD (`hud=0`): the identical set. **The HUD contributes zero
  violations.** The fixture chrome is intentional (the bench mimics
  play2048.co) and is not a HUD deliverable.
- The one HUD-owned violation found mid-walk (item 4 above) was fixed and is
  absent from both final scans.

## Deferred / not captured here

- **User-stop route in the browser** (clicking Stop mid-run): covered by the
  unit/fixture suite; the deterministic browser run ends in game over, so no
  screenshot of a user-initiated stop was captured.
- **Video recording**: the walk's flows are keyboard-only interactions; each
  step's before/after is a static capture plus measured DOM values.
- **Host keyboard conflict on a live board**: the leak check ran at game over
  (the game logs the key as ignored). On a live board the pre-fix behavior
  would have moved the game too; the fix stops propagation before the host
  handler can act, and the fixture's capture-phase counter still records the
  physical key by design.
- **Reduced-motion pulse animation check**: verified via the CSS block's
  `animation: none !important` unit contract; the pulse was not visually
  recorded under emulation.
