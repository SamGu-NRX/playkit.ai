# Requirements Document

## Introduction

This feature involves creating a browser extension that can automatically play 2048-like games on websites by integrating with the existing C++ solver algorithms. The extension will detect 2048 game boards on web pages, extract the current game state, apply AI strategies to determine optimal moves, and execute those moves automatically. The system should be adjustable, allowing users to select different AI algorithms and parameters, and should work across multiple platforms including mobile devices.

## Requirements

### Requirement 1 — Installability & Basic Operation

**User Story:** As a user, I want to install a tool that automatically detects and plays 2048 games on websites, so I can watch the AI solve the game without manual intervention.

#### Acceptance Criteria

1. WHEN the tool is installed THEN the system SHALL provide:
   - a Manifest V3 extension build for desktop Chromium browsers (Chrome/Edge/Brave),
   - a WebExtension build for desktop Firefox,
   - and a Safari Web Extension package for Safari (desktop and iOS via Apple tooling).
2. WHEN a user visits a webpage containing a 2048-like game THEN the system SHALL display an in‑page activation control in a Shadow‑DOM HUD overlay (content script/bookmarklet), without conflicting with page CSS.
3. WHEN the game board is detected THEN the system SHALL extract the current 4×4 grid state and tile values via a pluggable adapter.
4. WHEN the user clicks the activation button THEN the system SHALL begin automatically playing using the current strategy.
5. WHEN Content Security Policy (CSP) blocks remote scripts or eval THEN the Chromium/Firefox/Safari extension builds SHALL continue to function; additionally, a bookmarklet mode SHALL be provided for quick ad‑hoc use, with documentation on an inline (self‑contained) fallback.

### Requirement 2 — Strategy Selection & Parameters

**User Story:** As a user, I want to choose from different AI algorithms and adjust their parameters, so that I can experiment with various solving strategies and optimize performance.

#### Acceptance Criteria

1. WHEN the user opens settings (popup or HUD) THEN the system SHALL display strategies including Expectimax, Monte Carlo, and heuristic-based approaches, with a default “naive” runtime strategy (direction bias + DOM‑change check).
2. WHEN the user selects an AI strategy THEN the system SHALL allow configuration of strategy-specific parameters (depth, trials, heuristic weights) and persist them per origin.
3. WHEN the user changes algorithm settings THEN the system SHALL apply the new configuration to subsequent moves without requiring page reload.
4. WHEN using Expectimax strategy THEN the system SHALL allow selection of heuristics (corner, monotonicity, wall-building, score-based) consistent with the C++ implementation.

### Requirement 3 — Cross‑Implementation Support & Mobile Reality

**User Story:** As a user, I want the solver to work across many 2048 variants and on mobile where supported, so I can use it broadly.

#### Acceptance Criteria

1. WHEN encountering different 2048 implementations THEN the system SHALL adapt to various DOM structures via pluggable adapters (site‑specific and generic heuristic).
2. WHEN the game uses keyboard controls THEN the system SHALL simulate appropriate key events; WHEN the game uses touch controls THEN the system SHALL simulate swipe gestures.
3. WHEN targeting mobile platforms THEN the system SHALL provide packaged support for Firefox for Android and Safari on iOS (via Safari Web Extension). Chrome on Android/iOS lacks extension support and SHALL be documented as unsupported; optional alternatives (bookmarklet with limitations or a mini‑browser app) SHALL be documented.
4. WHEN running on supported mobile browsers THEN the system SHALL maintain detection and move execution parity with desktop.
5. WHEN the extension encounters the target site https://mitchgu.github.io/GetMIT/ THEN the system SHALL successfully detect and play the game (adapter may be site‑specific).

### Requirement 4 — Real‑Time Feedback & Control

**User Story:** As a user, I want real-time feedback and control over the automated gameplay, so that I can monitor performance and intervene when necessary.

#### Acceptance Criteria

1. WHEN the AI is actively playing THEN the system SHALL display current stats (score, highest tile, moves made) in the HUD.
2. WHEN the AI is running THEN the system SHALL provide pause/resume controls in the HUD and/or popup.
3. WHEN the game ends THEN the system SHALL display final results and offer to restart automatically.
4. WHEN the AI encounters an error THEN the system SHALL display error information and allow manual intervention.
5. WHEN the user stops automation THEN the system SHALL immediately cease all automated actions.

### Requirement 5 — C++/WASM Integration & Fidelity

**User Story:** As a developer, I want the extension to integrate the existing C++ solver algorithms efficiently, so that the AI performance matches the original implementation.

#### Acceptance Criteria

1. WHEN calculating moves with advanced strategies THEN the system SHALL use a WebAssembly build of the existing C++ algorithms.
2. WHEN board states are processed THEN the system SHALL maintain the same bitwise board representation as the original solver.
3. WHEN heuristics are applied THEN the system SHALL produce identical evaluations to the C++ implementation.
4. WHEN strategies are executed THEN the system SHALL achieve similar performance metrics (win rates, average scores) as the original solver.
5. WHEN the WASM module fails to load or initialize THEN the system SHALL fall back to the naive runtime strategy (direction bias + DOM‑change check) without crashing.

### Requirement 6 — Robustness & Edge Cases

**User Story:** As a user, I want the extension to handle various game states and edge cases gracefully, so that it works reliably across different scenarios.

#### Acceptance Criteria

1. WHEN the game board is not fully loaded THEN the system SHALL wait for complete initialization before starting.
2. WHEN the game is already in progress THEN the system SHALL detect the current state and continue from that point.
3. WHEN the game ends (win or lose) THEN the system SHALL detect the end state and stop automation.
4. WHEN the webpage structure changes THEN the system SHALL attempt to re-detect the game board automatically and reattach the adapter.
5. WHEN visibility changes to hidden THEN the system SHALL pause the automation loop and resume when visible.

### Requirement 7 — Performance, CSP, and Overlay UX

**User Story:** As a user, I want fast, safe automation that doesn’t break the page.

#### Acceptance Criteria

1. WHEN running the automation loop THEN the system SHALL throttle attempts to roughly 100–150 ms and only enqueue a new move when a DOM change indicates progress.
2. WHEN injecting the HUD THEN the system SHALL render it inside a Shadow DOM, maintain a high `z-index`, and use `pointer-events` to avoid blocking the game canvas.
3. WHEN CSP blocks remote scripts THEN the system SHALL use the extension build; the bookmarklet SHALL offer an inline self-contained build option.
4. WHEN executing moves THEN the system SHALL verify changes via a board hash and log no‑ops for diagnostics.

### Requirement 8 — Ethics & TOS

**User Story:** As an operator, I want the tool to encourage responsible use.

#### Acceptance Criteria

1. The system SHALL include a clear notice advising use only on personal, single‑player pages and to respect site Terms of Service.
2. The system SHALL default to inactive and require explicit user activation on each page.
3. The system SHALL avoid network calls to external services by default.
