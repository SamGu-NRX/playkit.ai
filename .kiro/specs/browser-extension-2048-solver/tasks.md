# Implementation Plan

- [ ] 1. Set up project structure and WebAssembly compilation

  - Create browser extension directory structure with manifest.json, popup.html, and core JavaScript files
  - Set up build system for compiling C++ solver to WebAssembly using Emscripten
  - Create enhanced export bindings for WebAssembly integration with board utilities and strategy factory functions
  - Define dual build outputs: minified IIFE for bookmarklet and content script bundle for MV3/WebExtension (no frameworks)
  - Establish CI to build artifacts on push (bookmarklet `2048-hud.min.js`, extension zip packages)
  - Document CSP considerations and fallback to extension/inline bookmarklet in restricted contexts
  - _Requirements: 1.1, 1.5, 5.1, 5.2, 5.3, 7.3_

- [ ] 2. Implement core WebAssembly solver integration

  - [ ] 2.1 Create WebAssembly loader and solver engine interface

    - Write TypeScript interfaces for ISolverEngine with strategy management and move calculation
    - Implement WebAssembly module loading with error handling and fallback mechanisms
    - Create board state conversion utilities between JavaScript arrays and C++ bitwise representation
    - Align heuristic functions with C++ (corner, monotonicity, wall-building, score-based) and expose via config
    - Add explicit fallback to runtime naive strategy when WASM fails to load or initialize (non-crashing)
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ] 2.2 Implement strategy configuration system

    - Create strategy factory functions for Expectimax, Monte Carlo, and other algorithms
    - Implement parameter validation and configuration management for each strategy type
    - Add heuristic selection system with all available heuristics (corner, monotonicity, wall-building, etc.)
    - Persist per-origin strategy and parameters in extension storage (with sane defaults)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]\* 2.3 Write unit tests for solver integration
    - Create test cases for board state conversion accuracy
    - Write tests comparing WebAssembly output with expected C++ solver results
    - Add performance benchmarks for move calculation latency
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 3. Develop game detection and DOM interaction system

  - [ ] 3.1 Create game detection engine

    - Implement DOM pattern recognition for common 2048 game structures
    - Write board state extraction algorithms that parse tile values from various DOM formats (site-specific and generic)
    - Define Adapter contract (canAttach, readBoard, sendMove) and implement baseline adapters:
      - play2048-style: `.tile tile-<v> tile-position-x-y`
      - generic 4×4 numeric grid: cluster visible numbers (2^n) by position
    - Add game type identification (standard 2048, variants, custom implementations)
    - Add MutationObserver on tile containers to hint change events and reduce redundant polling
    - _Requirements: 1.2, 1.3, 3.1, 3.2_

  - [ ] 3.2 Implement move execution system

    - Create move executor with support for keyboard arrow dispatch and synthetic swipe gestures (touch fallback)
    - Implement move completion detection via DOM-change check (hashed board before/after)
    - Add loop throttling (100–150 ms) and pause when `document.visibilityState !== 'visible'`
    - Add support for different control schemes (swipe, click, keyboard)
    - _Requirements: 1.4, 3.3, 3.4, 7.1, 7.4_

  - [ ] 3.3 Add target site compatibility

    - Implement specific detection patterns for https://mitchgu.github.io/GetMIT/
    - Create adaptive selectors that work across different 2048 implementations
    - Add mobile browser compatibility with touch event handling and timing adjustments
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [ ]\* 3.4 Write integration tests for game detection
    - Create test cases for various 2048 site structures
    - Write tests for move execution accuracy, DOM-change detection, and throttling behavior
    - Add mobile browser simulation tests (touch gestures, visibility pause)
    - _Requirements: 1.2, 3.2, 3.3, 3.4, 7.1, 7.4_

- [ ] 4. Build browser extension interface and controls

  - [ ] 4.1 Create extension popup UI

    - Design and implement popup.html with strategy selection dropdown and parameter controls
    - Add real-time game statistics display (score, highest tile, moves made)
    - Implement pause/resume controls and stop automation button
    - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.3, 4.5_

  - [ ] 4.2 Implement background service worker

    - Create background.js for extension state management and persistence
    - Add message passing system between popup, background, and content scripts
    - Implement settings storage and retrieval using chrome.storage API
    - _Requirements: 2.2, 2.3, 4.1, 4.2_

  - [ ] 4.3 Develop content script injection system
    - Create content.js that injects into web pages, initializes HUD overlay, and starts detection
    - Implement Shadow DOM HUD with high z-index, draggable header, and non-blocking pointer-events
    - Provide minimal HUD controls: Detect, Auto-solve, Step, direction bias selector, status log
    - Include a visible Ethics/TOS notice in the HUD and default to inactive; require explicit activation on each page
    - Namescope CSS within Shadow DOM to avoid collisions
    - Implement communication bridge between content script and extension popup (optional)
    - Add automatic game detection on page load with activation button display
    - Provide bookmarklet loader documentation and inline (self-contained) variant for CSP-restricted pages
    - _Requirements: 1.1, 1.2, 1.5, 4.1, 7.2, 8.1, 8.2_

- [ ] 5. Implement automation engine and game loop

  - [ ] 5.1 Create main automation controller

    - Implement game loop that reads board, chooses direction order (keep max tile in corner), executes, and verifies DOM change
    - Implement fallback random move when no direction changes the board (trap escape)
    - Add game state monitoring with automatic start/stop detection and end-of-game handling
    - Create error handling and recovery mechanisms for failed moves or detection issues
    - _Requirements: 1.4, 4.3, 4.4, 6.1, 6.2, 6.3, 7.1, 7.4_

  - [ ] 5.2 Add real-time feedback system

    - Implement live statistics tracking and HUD updates (score, highest tile, move count)
    - Create game end detection with final results display and restart options (if restart button is detectable)
    - Add performance monitoring and move timing optimization; expose logs in HUD for diagnostics
    - _Requirements: 4.1, 4.3, 7.1_

  - [ ]\* 5.3 Write end-to-end automation tests
    - Create automated tests that run full game sessions on test sites
    - Write performance tests comparing extension results with native C++ solver
    - Add cross-browser compatibility tests for Chrome, Firefox, and Safari
    - _Requirements: 5.4, 6.1, 6.2, 6.3_

- [ ] 6. Add cross-platform support and mobile compatibility

  - [ ] 6.1 Implement mobile browser adaptations

    - Add touch event simulation for mobile game controls (swipe gestures, touch events API)
    - Implement responsive UI adjustments for HUD/popup on small screens
    - Create mobile-specific game detection patterns and timing adjustments (longer DOM-change timeouts)
    - _Requirements: 3.1, 3.3, 3.4_

  - [ ] 6.2 Create Safari extension compatibility

    - Adapt manifest.json for Safari extension format
    - Implement Safari-specific APIs and permission handling
    - Add Safari Web Extension converter compatibility
    - Package and validate iOS Safari variant via Xcode tooling (App Extension)
    - _Requirements: 1.1, 3.3_

  - [ ]\* 6.3 Write mobile and cross-browser tests
    - Create mobile browser simulation tests for touch interactions
    - Write Safari-specific functionality tests for injected overlay and permissions
    - Add performance tests on mobile devices; verify pause-on-hidden behavior
    - _Requirements: 3.1, 3.3, 3.4_

- [ ] 7. Implement advanced features and error handling

  - [ ] 7.1 Add robust error handling and recovery

    - Implement comprehensive error detection for network issues, DOM changes, and solver failures
    - Create automatic retry mechanisms with bounded backoff and circuit breaker for repeated failures
    - Add user notification system for errors and recovery actions
    - Log no-op moves and adapter reattachments for diagnostics (local only, no external network)
    - _Requirements: 4.4, 6.4, 6.5_

  - [ ] 7.2 Create settings persistence and migration

    - Implement settings export/import functionality
    - Add data migration system for extension updates
    - Create backup and restore mechanisms for user configurations
    - _Requirements: 2.3, 4.2_

  - [ ]\* 7.3 Add performance monitoring and analytics
    - Implement local performance tracking and statistics collection (no external transmission)
    - Create performance comparison tools between strategies (naive vs WASM expectimax)
    - Add memory usage monitoring and optimization alerts; provide HUD debug view
    - _Requirements: 5.4, 4.1, 7.1, 7.4_

- [ ] 8. Package and prepare for distribution

  - [ ] 8.1 Create build and packaging system

    - Set up automated build pipeline producing:
      - Minified bookmarklet bundle `2048-hud.min.js` (IIFE)
      - MV3/WebExtension content script bundle(s)
    - Create distribution packages for Chrome Web Store, Firefox Add-ons, and Safari Extensions (iOS included)
    - Implement version management and release automation
    - _Requirements: 1.1_

  - [ ] 8.2 Add documentation and user guides

    - Create user manual with installation and usage instructions (bookmarklet + MV3 + Firefox Android + iOS Safari)
    - Write developer documentation for extension architecture, adapter contract, and WebAssembly integration
    - Add troubleshooting guide for CSP, mobile limitations (Chrome Android/iOS), and adapter fallbacks
    - Include ethics/TOS guidance and a privacy note (no external network calls by default)
    - _Requirements: 1.1, 2.1, 3.2, 3.3, 8.1, 8.3_

  - [ ]\* 8.3 Perform final testing and validation
    - Run comprehensive test suite across all supported browsers and platforms
    - Validate performance benchmarks against original C++ solver
    - Conduct user acceptance testing with various 2048 sites and game variants
    - _Requirements: 5.4, 6.1, 6.2, 6.3_
