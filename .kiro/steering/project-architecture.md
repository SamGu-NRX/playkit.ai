---
inclusion: always
---

# Project Architecture Standards

## Overview

This project implements a browser extension that automatically plays 2048-like games by integrating existing C++ solver algorithms via WebAssembly. The architecture follows a modular, cross-platform approach with clear separation of concerns.

## Core Architecture Principles

### 1. Modular Design

- **Adapter Pattern**: Game detection uses pluggable adapters for different 2048 implementations
- **Strategy Pattern**: AI algorithms are interchangeable via a common interface
- **Shadow DOM Isolation**: UI components are isolated from host page CSS/JS

### 2. Cross-Platform Support

- **Manifest V3**: Primary extension format for Chromium browsers
- **WebExtension**: Firefox compatibility
- **Safari Web Extension**: Safari desktop and iOS support
- **Bookmarklet Fallback**: CSP-restricted environments

### 3. Performance-First Approach

- **WebAssembly Integration**: C++ solver compiled to WASM for optimal performance
- **Throttled Execution**: 100-150ms move intervals with DOM change detection
- **Lazy Loading**: Components loaded only when needed

## Component Structure

### Extension Components

```
src/extension/
├── manifest.json     # MV3 manifest
├── content.js        # Shadow DOM HUD + game detection
├── background.js     # Service worker (future)
└── popup.html        # Settings UI (future)
```

### Solver Integration

```
solver/                # C++ implementation
├── game.hpp          # Core game mechanics
├── strategies/       # AI algorithms
├── heuristics.hpp    # Evaluation functions
└── demo/website/     # WASM export examples
```

### Build Outputs

- **Extension Packages**: MV3/WebExtension/Safari bundles
- **Bookmarklet**: Minified IIFE bundle (`2048-hud.min.js`)
- **WebAssembly**: Compiled solver (`solver.wasm` + `solver.js`)

## Key Interfaces

### Adapter Contract

```typescript
interface Adapter {
  canAttach(): boolean; // Site compatibility check
  readBoard(): number[][] | null; // Extract 4x4 game state
  sendMove(dir: 0 | 1 | 2 | 3): void; // Execute move (0=Up,1=Right,2=Down,3=Left)
}
```

### Solver Engine

```typescript
interface ISolverEngine {
  initialize(): Promise<void>;
  setStrategy(strategy: StrategyType, params: StrategyParams): void;
  pickMove(board: bigint): number;
  evaluateBoard(board: bigint): number;
}
```

## Data Flow

1. **Detection**: Content script detects 2048 game via adapters
2. **State Extraction**: Adapter reads current board state from DOM
3. **Move Calculation**: WASM solver determines optimal move
4. **Move Execution**: Adapter dispatches keyboard/touch events
5. **Verification**: DOM change detection confirms move completion

## Error Handling Strategy

### Graceful Degradation

- WASM load failure → fallback to naive strategy
- Adapter failure → retry with generic detector
- Move execution failure → retry with backoff

### Recovery Mechanisms

- Automatic adapter reattachment on DOM changes
- Circuit breaker for repeated failures
- User notification for unrecoverable errors

## Security Considerations

### Content Security Policy

- Extension builds bypass CSP restrictions
- Bookmarklet provides inline fallback option
- No external network requests by default

### Isolation

- Shadow DOM prevents CSS conflicts
- Sandboxed WASM execution
- Minimal required permissions (activeTab, storage)

## Mobile Considerations

### Platform Support

- **Firefox Android**: Full WebExtension support
- **Safari iOS**: Via Safari Web Extension tooling
- **Chrome Mobile**: Unsupported (no extension API)

### Touch Adaptations

- Synthetic swipe gesture simulation
- Responsive HUD for small screens
- Longer DOM change timeouts for slower devices

## Development Guidelines

### Code Organization

- Keep adapters simple and focused
- Maintain C++ solver compatibility
- Use TypeScript interfaces for contracts
- Document CSP considerations

### Testing Strategy

- Unit tests for core algorithms
- Integration tests with real 2048 sites
- Cross-browser compatibility testing
- Performance benchmarking vs native C++

### Build Process

- Automated CI builds on push
- Multiple output formats (extension + bookmarklet)
- Version management and release automation
