# PR.md — burst12-playkit-overlay-hud-a11y

- **Branch:** `obv/burst12-playkit-overlay-hud-a11y`
- **Base:** `alpha` @ `72e5543`
- **Head:** `1b835ca` (2 commits on top of base)
- **Task:** PR #58 "Next packets" 3–5 — the helper panel (HUD) works with a keyboard and a screen reader

## What changed

The overlay HUD was mouse-first: controls had no programmatic name, state changes were silent, the collapse button's accessible name never changed, and settings the active engine cannot honor (Strategy, Heuristic) stayed enabled and did nothing. This change makes the panel keyboard- and screen-reader-operable:

1. **Named, labelled controls** (`src/hud/templates.js`, `src/hud/view.js`) — every control gets a visible label tied by `for`/`id`, plus `aria-label` where the visible text is an icon. The collapse button's accessible name now flips with its state ("Collapse panel" ↔ "Expand panel") and carries `aria-expanded`/`aria-controls`.
2. **Polite status announcer** (`src/hud/templates.js`, `src/hud/hud.js`) — a `role="status" aria-live="polite"` region announces the outcomes that matter: detection ("Play2048Adapter detected."), run transitions ("Auto-solve started." / "Auto-solve paused." / "Auto-solve resumed."), and game over with the final score. Per-move tiles are deliberately **not** announced — a run produces dozens of moves and would drown a screen-reader user in noise. The panel itself is a named region (`role="region" aria-label="AI 2048 Solver"`), so keyboard focus can be found with landmark navigation.
3. **Engine honesty** (`src/hud/templates.js`, `src/hud/view.js`) — when the active engine cannot honor Strategy/Heuristic, those selects render `disabled` with `aria-describedby="strategy-engine-hint"` pointing at a visible hint ("Strategy and heuristic options need the WASM solver."). Previously they were enabled, changeable, and silently ignored.
4. **Respects `prefers-reduced-motion`** (`src/hud/templates.js`) — the auto-solving pulse animation and panel expand/collapse transition are disabled under `reduce`, and the pulse class is not applied at all.
5. **Regression suite** (`src/test/hud-a11y.test.mjs`, new) — 10 jsdom tests: control naming/labelling, live-region announcements, collapse name/`aria-expanded` sync in both directions, engine gating + describedby wiring, reduced-motion CSS, and select `change` → `setSolverConfig` wiring.

## Type of change

- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)

## Why

PR #58's J5 browser pass found the HUD unusable without a mouse: unnamed controls, silent state changes, and settings that lied about being adjustable. The HUD is the product's primary surface for non-sighted and keyboard users; this packet closes those findings.

## How it works

Keyboard path through the panel (all steps verified in real Chromium below):

```
Tab (×5) → Collapse [Enter/Space toggles name+aria-expanded]
Tab      → Detect Game   [Enter → "Play2048Adapter detected." in live region]
Tab      → Auto-solve    [Enter → "Auto-solve started."; Space on running button → "Auto-solve paused."]
Tab      → Step
Tab      → Direction priority select [type-ahead "u" → value changes, change fires]
           Strategy / Heuristic: disabled + hint while the engine is Fallback
```

## UI changes

Visible-state changes: labels beside every control, disabled Strategy/Heuristic with the hint, and the collapse button toggling. Captures are in `evidence/` (12 files, all generated this session):

| File | Shows |
|---|---|
| `01-tests-fail-before.png`, `02-tests-pass-after.png` | jsdom suite: 10 fail on the base HUD → 10 pass on this branch |
| `03-axe-before.png`, `04-axe-after.png` | axe-core in real Chromium: 6 full-page violations with 3 critical `select-name` + 3 `region` on the HUD → **0 HUD nodes flagged** |
| `05-tab-order-collapse-focus.png` | Tab order: page links → collapse button focused, focus ring visible |
| `06-collapse-keyboard-toggled.png` | After Enter: panel collapsed, name "Expand panel", `aria-expanded=false` |
| `07-detect-announced.png` | After Enter on Detect: adapter detected, live region announced |
| `08-autosolve-running-announced.png` | After Enter on Auto-solve: "Auto-solve started." |
| `09-pause-announced.png` | After Space: "Auto-solve paused." |
| `10-select-keyboard-changed.png` | Type-ahead changed the select (`3,2,1,0` → `0,2,1,3`) |
| `11-fallback-disabled-hint.png` | Strategy/Heuristic disabled with visible hint under the Fallback engine |
| `12-reduced-motion-animation-off.png` | Under `prefers-reduced-motion: reduce`: pulse `none`, panel transition `0s` |

## Verification

- `node --test src/test/hud-a11y.test.mjs` (new suite): **10 pass / 0 fail** against this branch; same suite against the base HUD: 10 fail / 0 pass.
- axe-core 4.x in headless Chromium against the served injected HUD (`gauntlet/bridge/browser/server.mjs` fixtures):
  - Base: 6 full-page violations, **HUD nodes: 6** — 3 critical (`select-name`) + 3 `region`.
  - This branch: 5 full-page violations, **HUD nodes: 0**. The remainder belong to the vendored game page itself (`html-has-lang`, `landmark-one-main`, `meta-viewport`, `region` ×6 on page content, `.restart-button` contrast) — out of scope for the HUD, listed for the next packet.
- Real-browser keyboard journey (Playwright keyboard, no `el.focus()`/`el.click()` shortcuts): tab order, collapse toggle, detection announcement, start/pause announcements, select type-ahead, engine honesty, reduced motion — all verified; JSON state dumps and screenshots captured per step.
- Reduced-motion probe: `reduce` → `buttonAnimation: "none 0s"`, `panelTransition: "all 0s"`; `no-preference` → `"pulse 1s infinite"`, `"all 0.3s"`.
- Full pre-existing suites on this branch: node overlay contract suite green; no other suites touch `src/hud/`.

Suggested reproduction: build (`node scripts/build-phase0.js`), serve the fixtures, inject `dist/2048-hud.min.js` on the 2048 page, and walk the keyboard path above with a screen reader or axe DevTools.

## Caveats / next packets

- **Latent defect found while testing (outside owned paths, left for a follow-up packet):** `src/adapters/index.js` re-exports `globalAdapterRegistry` without creating a local binding, while `detectGame()` references it — the controller-free path throws a `ReferenceError` in jsdom. The extension path always reaches the HUD through the controller, so the defect is masked there.
- The headless-font environment renders the HUD's 🎯 title emoji as a box glyph; real browsers ship the emoji font. Cosmetic only, not a change requirement.
- Remaining axe findings are page-level (vendored 2048 page), not HUD-level.
- Per-move announcements intentionally omitted (see "Why"); a screen-reader-only move summary could be a future packet if requested.

🔗 [Obvious Project](https://app.obvious.ai/p/agent-tools-PQyawTQb) · 🧵 [Obvious Thread](https://app.obvious.ai/p/agent-tools-PQyawTQb?thread=th_2mHthuvn) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/playkit-overlay-the-helper-panel-works-with-a-keyb-task:todo_clEjGbN1)
