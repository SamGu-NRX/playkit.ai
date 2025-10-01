# Implementation Plan

- [ ] 1. Core game detection and adapter system

  - Create base Adapter interface with canAttach(), readBoard(), sendMove() methods
  - Implement play2048.co adapter with DOM selectors for tiles and score
  - Implement generic 4x4 grid adapter using heuristic detection
  - Create adapter registry with automatic site detection
  - _Requirements: 1.3, 3.1, 3.5_

- [ ] 2. Shadow DOM HUD overlay

  - Create isolated Shadow DOM container with high z-index
  - Implement draggable, collapsible HUD panel
  - Add basic controls: Detect Game, Start/Stop, Step buttons
  - Style with CSS to avoid conflicts with host page
  - _Requirements: 1.2, 7.2_

- [ ] 3. Basic move execution system

  - Implement keyboard event simulation (arrow keys)
  - Add touch gesture simulation for mobile support
  - Create move throttling with 100-150ms delays
  - Add DOM change detection to verify move completion
  - _Requirements: 3.2, 7.1, 7.4_

- [ ] 4. Naive AI strategy implementation

  - Create simple direction bias strategy (corner preference)
  - Implement board state hashing for change detection
  - Add stuck detection with randomization fallback
  - Create game end detection logic
  - _Requirements: 1.4, 6.3, 6.4_

- [ ] 5. Shared runtime architecture

  - Structure code for dual compilation (IIFE + content script)
  - Create build system for bookmarklet and extension outputs
  - Implement visibility-based pause/resume functionality
  - Add MutationObserver for efficient change detection
  - _Requirements: 1.6, 1.7, 6.5_

- [ ] 6. Extension manifest and packaging

  - Create Manifest V3 configuration with minimal permissions
  - Implement content script injection system
  - Package WebAssembly files as web accessible resources
  - Create extension directory structure
  - _Requirements: 1.1, 1.5, 7.5_

- [ ] 7. WebAssembly solver integration

  - Compile existing C++ solver using Emscripten
  - Create JavaScript bindings for board conversion utilities
  - Implement ISolverEngine interface with WASM backend
  - Add graceful fallback to naive strategy on WASM failure
  - _Requirements: 5.1, 5.2, 5.5, 5.6_

- [ ] 8. Strategy selection and configuration

  - Implement Expectimax strategy with depth/probability parameters
  - Add heuristic selection (corner, monotonicity, score-based)
  - Create strategy factory pattern for algorithm switching
  - Add per-origin settings persistence
  - _Requirements: 2.1, 2.2, 2.3, 5.3, 5.4_

- [ ] 9. Real-time feedback and controls

  - Display current game stats (score, max tile, moves) in HUD
  - Implement pause/resume controls with immediate response
  - Add game end detection and restart functionality
  - Create error display and manual intervention options
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 10. Cross-browser compatibility

  - Create Firefox WebExtension build configuration
  - Implement Safari Web Extension packaging
  - Add browser-specific event handling differences
  - Test and validate cross-platform functionality
  - _Requirements: 1.1, 3.3_

- [ ]\* 11. Unit testing suite

  - Write tests for adapter detection and board extraction
  - Create tests for move execution and timing
  - Add WebAssembly integration tests
  - Test strategy switching and parameter validation
  - _Requirements: 5.4_

- [ ]\* 12. Integration testing

  - Test end-to-end automation on target sites
  - Validate cross-browser compatibility
  - Performance test against native C++ solver
  - Mobile browser functionality testing
  - _Requirements: 3.5, 5.4_

- [ ] 13. Error handling and robustness

  - Implement bounded retry logic for failed operations
  - Add automatic adapter re-detection on DOM changes
  - Create comprehensive error logging without network calls
  - Handle edge cases (game already in progress, board not loaded)
  - _Requirements: 6.1, 6.2, 6.6, 4.4_

- [ ]\* 14. Mobile platform optimization

  - Package Firefox for Android WebExtension
  - Create Safari iOS extension via Xcode tooling
  - Optimize touch handling and timing for mobile
  - Document Chrome mobile limitations and alternatives
  - _Requirements: 3.3, 3.4_

- [ ]\* 15. Advanced features and polish
  - Implement canvas-only game support with OCR fallback
  - Add comprehensive performance monitoring
  - Create user documentation and ethical use guidelines
  - Optimize bundle size and loading performance
  - _Requirements: 3.6, 7.3, 8.1, 8.2, 8.3_
