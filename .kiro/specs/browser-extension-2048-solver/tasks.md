# Implementation Plan (Overlay‑First, Phased)

This plan follows the steering guidance:

- Adapters/detection: .kiro/steering/game-detection-patterns.md
- HUD/shadow DOM/singleton/events: .kiro/steering/browser-extension-patterns.md
- Coding/testing: .kiro/steering/coding-standards.md, .kiro/steering/testing-guidelines.md
- WASM: .kiro/steering/webassembly-integration.md

## Phase 0 — Baseline overlay runtime (desktop‑first)

**Overview:** HUD: Inject a Shadow DOM panel (draggable, high `z-index`, non‑blocking `pointer-events`). Controls: Detect, Auto‑solve, Step, direction priority. Adapters: Implement two per the steering contract: play2048‑style and generic numeric 4×4. Use the Adapter Registry pattern. Driver: Naive DOM‑change loop. Send preferred direction; wait ~120–150 ms; accept only on board hash change; randomize if stuck. Change detection: Add a MutationObserver on likely containers; pause loop when `document.visibilityState !== 'visible'`. Shared runtime: Organize code to compile to both IIFE (bookmarklet) and MV3 `content.js` with no logic drift. Target site: Ensure compatibility with https://mitchgu.github.io/GetMIT/. Deliverables: `2048-hud.min.js` and `content.js` from one codebase.
**Requirements:** 1.2, 1.4, 1.5, 3.1, 3.2, 3.5, 7.1, 7.4

- [x] 0.1 Core game detection and adapter system

  - Create base Adapter interface with canAttach(), readBoard(), sendMove() methods per steering contract
  - Implement play2048‑style adapter with DOM selectors for tiles and score
  - Implement generic numeric 4×4 adapter using heuristic detection
  - Create adapter registry with automatic site detection using Adapter Registry pattern
  - Ensure compatibility with https://mitchgu.github.io/GetMIT/
  - _Requirements: 1.3, 3.1, 3.5_

- [x] 0.2 Shadow DOM HUD overlay

  - Inject Shadow DOM panel (draggable, high `z-index`, non‑blocking `pointer-events`)
  - Implement draggable, collapsible HUD panel
  - Add controls: Detect, Auto‑solve, Step, direction priority
  - Style with CSS to avoid conflicts with host page
  - _Requirements: 1.2, 7.2_

- [x] 0.3 Basic move execution system (Driver)

  - Implement naive DOM‑change loop
  - Send preferred direction; wait ~120–150 ms; accept only on board hash change; randomize if stuck
  - Implement keyboard event simulation (arrow keys)
  - Add touch gesture simulation for mobile support
  - Create move throttling with 100-150ms delays
  - Add DOM change detection to verify move completion
  - _Requirements: 3.2, 7.1, 7.4_

- [x] 0.4 Change detection and visibility handling

  - Add MutationObserver on likely containers
  - Pause loop when `document.visibilityState !== 'visible'`
  - Implement board state hashing for change detection
  - Add stuck detection with randomization fallback
  - Create game end detection logic
  - _Requirements: 1.4, 6.3, 6.4_

- [x] 0.5 Shared runtime architecture
  - Organize code to compile to both IIFE (bookmarklet) and MV3 `content.js` with no logic drift
  - Structure code for dual compilation (IIFE + content script)
  - Create build system for bookmarklet and extension outputs
  - Implement visibility-based pause/resume functionality
  - Deliverables: `2048-hud.min.js` and `content.js` from one codebase
  - _Requirements: 1.6, 1.7, 6.5_

## Phase 1 — MV3/WebExtension packaging

**Overview:** MV3: Add `manifest.json` and content script entry that loads the shared runtime. Docs: Update `src/extension/README.md` with unpacked install instructions and parity notes. Performance: Keep bundle small (goal ≤ ~20 KB gzipped); avoid frameworks; no external network calls.
**Requirements:** 1.1, 1.6, 7.5, 8.1

- [x] 1.1 Extension manifest and packaging

  - Add `manifest.json` and content script entry that loads the shared runtime
  - Create Manifest V3 configuration with minimal permissions
  - Implement content script injection system
  - Package WebAssembly files as web accessible resources
  - Create extension directory structure
  - _Requirements: 1.1, 1.5, 7.5_

- [x] 1.2 Documentation and performance optimization
  - Update `src/extension/README.md` with unpacked install instructions and parity notes
  - Keep bundle small (goal ≤ ~20 KB gzipped); avoid frameworks; no external network calls
  - Optimize bundle size and loading performance
  - _Requirements: 1.1, 1.6, 7.5, 8.1_

## Phase 2 — Pragmatic TS adoption (optional)

**Overview:** JS-first: Maintain JS with JSDoc types. If a bundler is introduced, migrate internals to TS; emit JS bundles + optional `.d.ts`. Interfaces: Keep Adapter and Solver Engine contracts unchanged across JS/TS.
**Requirements:** 9.1, 9.2, 9.3

- [ ]\* 2.1 Pragmatic TypeScript adoption
  - Maintain JS with JSDoc types as primary approach
  - If a bundler is introduced, migrate internals to TS; emit JS bundles + optional `.d.ts`
  - Keep Adapter and Solver Engine contracts unchanged across JS/TS
  - _Requirements: 9.1, 9.2, 9.3_

## Phase 3 — WebAssembly solver integration

**Overview:** Compile solver: Use Emscripten; base on `solver/demo/website/export_players.cpp`. Package artifacts with the extension. Loader/interface: Implement `ISolverEngine` + board conversion utilities matching C++ bitwise representation. Strategies: Expectimax (depth/probability) with selectable heuristics (corner, monotonicity, wall‑building, score‑based). Fallback: On WASM load/init failure, continue with naive runtime.
**Requirements:** 2.1, 2.2, 5.1, 5.2, 5.3, 5.5

- [ ] 3.1 WebAssembly compilation and integration

  - Compile solver using Emscripten; base on `solver/demo/website/export_players.cpp`
  - Package artifacts with the extension
  - Create JavaScript bindings for board conversion utilities
  - Implement `ISolverEngine` + board conversion utilities matching C++ bitwise representation
  - _Requirements: 5.1, 5.2, 5.5_

- [ ] 3.2 Strategy implementation and configuration
  - Implement Expectimax strategy with depth/probability parameters
  - Add selectable heuristics (corner, monotonicity, wall‑building, score‑based)
  - Create strategy factory pattern for algorithm switching
  - Add graceful fallback: On WASM load/init failure, continue with naive runtime
  - _Requirements: 2.1, 2.2, 5.3, 5.5_

## Phase 4 — UI controls and persistence

**Overview:** Popup (optional): Strategy selector, parameters, live stats (score, max tile, moves). Pause/resume/stop. Storage: Persist per‑origin settings via extension storage; apply live without reload.
**Requirements:** 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 4.5

- [ ] 4.1 Real-time feedback and controls

  - Display current game stats (score, max tile, moves) in HUD
  - Implement pause/resume controls with immediate response
  - Add game end detection and restart functionality
  - Create error display and manual intervention options
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 4.2 Settings persistence and UI
  - Popup (optional): Strategy selector, parameters, live stats (score, max tile, moves). Pause/resume/stop
  - Add per-origin settings persistence via extension storage
  - Apply settings live without reload
  - _Requirements: 2.1, 2.2, 2.3, 4.5_

## Phase 5 — Mobile packaging

**Overview:** Firefox for Android: Package WebExtension; validate touch and timing. Safari (desktop/iOS): Convert via Xcode; validate permissions/CSP/injection. Document Chrome Android/iOS limitations; suggest bookmarklet or mini‑browser alternatives.
**Requirements:** 3.3, 6.1, 6.2

- [ ]\* 5.1 Mobile platform packaging

  - Firefox for Android: Package WebExtension; validate touch and timing
  - Safari (desktop/iOS): Convert via Xcode; validate permissions/CSP/injection
  - Create Firefox WebExtension build configuration
  - Implement Safari Web Extension packaging
  - Add browser-specific event handling differences
  - Test and validate cross-platform functionality
  - _Requirements: 1.1, 3.3, 6.1, 6.2_

- [ ]\* 5.2 Mobile optimization and documentation
  - Optimize touch handling and timing for mobile
  - Document Chrome Android/iOS limitations; suggest bookmarklet or mini‑browser alternatives
  - Mobile browser functionality testing
  - _Requirements: 3.3, 3.4_

## Phase 6 — Robustness and backlog

**Overview:** Error handling: Bounded retries, automatic adapter re‑detection/reattachment; log no‑ops locally (no network). Optional fallbacks: Canvas OCR (Tesseract.js) and trainer mode behind a feature flag (off by default). Tests: Unit (board conversion, adapter parsing), Integration (DOM‑change verification, throttling), cross‑browser/mobile checks.
**Requirements:** 3.6, 4.4, 6.6, 7.4, 9.1

- [ ] 6.1 Error handling and robustness

  - Bounded retries, automatic adapter re‑detection/reattachment; log no‑ops locally (no network)
  - Implement bounded retry logic for failed operations
  - Add automatic adapter re-detection on DOM changes
  - Create comprehensive error logging without network calls
  - Handle edge cases (game already in progress, board not loaded)
  - _Requirements: 6.1, 6.2, 6.6, 4.4_

- [ ]\* 6.2 Unit testing suite

  - Tests: Unit (board conversion, adapter parsing)
  - Write tests for adapter detection and board extraction
  - Create tests for move execution and timing
  - Add WebAssembly integration tests
  - Test strategy switching and parameter validation
  - _Requirements: 5.4, 9.1_

- [ ]\* 6.3 Integration testing

  - Tests: Integration (DOM‑change verification, throttling), cross‑browser/mobile checks
  - Test end-to-end automation on target sites
  - Validate cross-browser compatibility
  - Performance test against native C++ solver
  - Mobile browser functionality testing
  - _Requirements: 3.5, 3.6, 5.4, 7.4, 9.1_

- [ ]\* 6.4 Advanced features and optional fallbacks
  - Optional fallbacks: Canvas OCR (Tesseract.js) and trainer mode behind a feature flag (off by default)
  - Implement canvas-only game support with OCR fallback
  - Add comprehensive performance monitoring
  - Create user documentation and ethical use guidelines
  - _Requirements: 3.6, 7.3, 8.1, 8.2, 8.3_
