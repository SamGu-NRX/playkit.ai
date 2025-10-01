# Implementation Plan (Overlay‑First, Phased)

This plan follows the steering guidance:
- Adapters/detection: .kiro/steering/game-detection-patterns.md
- HUD/shadow DOM/singleton/events: .kiro/steering/browser-extension-patterns.md
- Coding/testing: .kiro/steering/coding-standards.md, .kiro/steering/testing-guidelines.md
- WASM: .kiro/steering/webassembly-integration.md

- [ ] Phase 0 — Baseline overlay runtime (desktop‑first)

  - HUD: Inject a Shadow DOM panel (draggable, high `z-index`, non‑blocking `pointer-events`). Controls: Detect, Auto‑solve, Step, direction priority.
  - Adapters: Implement two per the steering contract: play2048‑style and generic numeric 4×4. Use the Adapter Registry pattern.
  - Driver: Naive DOM‑change loop. Send preferred direction; wait ~120–150 ms; accept only on board hash change; randomize if stuck.
  - Change detection: Add a MutationObserver on likely containers; pause loop when `document.visibilityState !== 'visible'`.
  - Shared runtime: Organize code to compile to both IIFE (bookmarklet) and MV3 `content.js` with no logic drift.
  - Target site: Ensure compatibility with https://mitchgu.github.io/GetMIT/.
  - Deliverables: `2048-hud.min.js` and `content.js` from one codebase.
  - Requirements: 1.2, 1.4, 1.5, 3.1, 3.2, 3.5, 7.1, 7.4

- [ ] Phase 1 — MV3/WebExtension packaging

  - MV3: Add `manifest.json` and content script entry that loads the shared runtime.
  - Docs: Update `src/extension/README.md` with unpacked install instructions and parity notes.
  - Performance: Keep bundle small (goal ≤ ~20 KB gzipped); avoid frameworks; no external network calls.
  - Requirements: 1.1, 1.6, 7.5, 8.1

- [ ] Phase 2 — Pragmatic TS adoption (optional)

  - JS-first: Maintain JS with JSDoc types. If a bundler is introduced, migrate internals to TS; emit JS bundles + optional `.d.ts`.
  - Interfaces: Keep Adapter and Solver Engine contracts unchanged across JS/TS.
  - Requirements: 9.1, 9.2, 9.3

- [ ] Phase 3 — WebAssembly solver integration

  - Compile solver: Use Emscripten; base on `solver/demo/website/export_players.cpp`. Package artifacts with the extension.
  - Loader/interface: Implement `ISolverEngine` + board conversion utilities matching C++ bitwise representation.
  - Strategies: Expectimax (depth/probability) with selectable heuristics (corner, monotonicity, wall‑building, score‑based).
  - Fallback: On WASM load/init failure, continue with naive runtime.
  - Requirements: 2.1, 2.2, 5.1, 5.2, 5.3, 5.5

- [ ] Phase 4 — UI controls and persistence

  - Popup (optional): Strategy selector, parameters, live stats (score, max tile, moves). Pause/resume/stop.
  - Storage: Persist per‑origin settings via extension storage; apply live without reload.
  - Requirements: 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 4.5

- [ ] Phase 5 — Mobile packaging

  - Firefox for Android: Package WebExtension; validate touch and timing.
  - Safari (desktop/iOS): Convert via Xcode; validate permissions/CSP/injection.
  - Document Chrome Android/iOS limitations; suggest bookmarklet or mini‑browser alternatives.
  - Requirements: 3.3, 6.1, 6.2

- [ ] Phase 6 — Robustness and backlog

  - Error handling: Bounded retries, automatic adapter re‑detection/reattachment; log no‑ops locally (no network).
  - Optional fallbacks: Canvas OCR (Tesseract.js) and trainer mode behind a feature flag (off by default).
  - Tests: Unit (board conversion, adapter parsing), Integration (DOM‑change verification, throttling), cross‑browser/mobile checks.
  - Requirements: 3.6, 4.4, 6.6, 7.4, 9.1

