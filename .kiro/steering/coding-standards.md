---
inclusion: always
---

# Coding Standards and Best Practices

## JavaScript/TypeScript Standards

### Code Style

- **ES6+ Features**: Use modern JavaScript (async/await, arrow functions, destructuring)
- **No External Dependencies**: Keep extension lightweight, avoid frameworks
- **Consistent Naming**: camelCase for variables/functions, PascalCase for classes
- **Explicit Types**: Use TypeScript interfaces for all contracts

### Example Code Patterns

#### Adapter Implementation

```javascript
// Good: Simple, focused adapter
const adapter = {
  canAttach() {
    return !!document.querySelector(".tile-container .tile");
  },
  readBoard() {
    const cells = Array.from({ length: 4 }, () => Array(4).fill(0));
    // ... extraction logic
    return cells;
  },
  sendMove(dir) {
    dispatchMove(dir);
  },
};

// Bad: Overly complex, tightly coupled
class ComplexAdapter extends BaseAdapter {
  // ... too much inheritance and complexity
}
```

#### Error Handling

```javascript
// Good: Graceful degradation
async function loadSolver() {
  try {
    const wasm = await loadWebAssembly();
    return new WASMSolver(wasm);
  } catch (error) {
    console.warn("WASM failed, using fallback:", error);
    return new NaiveSolver();
  }
}

// Bad: Throwing errors without fallback
async function loadSolver() {
  const wasm = await loadWebAssembly(); // Can crash entire extension
  return new WASMSolver(wasm);
}
```

### DOM Interaction Guidelines

#### Shadow DOM Usage

```javascript
// Good: Isolated styling
const host = document.createElement("div");
const root = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `
  .card { /* scoped styles */ }
`;
root.appendChild(style);

// Bad: Global CSS pollution
document.head.innerHTML += "<style>.card { /* conflicts with page */ }</style>";
```

#### Event Handling

```javascript
// Good: Proper event simulation
function dispatchMove(dir) {
  const key = new KeyboardEvent("keydown", {
    key: DIRS[dir],
    keyCode: KEYCODES[dir],
    bubbles: true,
  });
  const target = document.activeElement || document.body;
  target.dispatchEvent(key);

  // Fallback touch simulation
  simulateSwipe(dir);
}

// Bad: Direct DOM manipulation
function dispatchMove(dir) {
  // Directly modifying game state - breaks game logic
  document.querySelector(".tile").style.transform = "translate(100px, 0)";
}
```

## C++ Integration Standards

### WebAssembly Bindings

```cpp
// Good: Clean interface with utilities
EMSCRIPTEN_BINDINGS(solver) {
    function("pickMove", &pickMove);
    function("boardFromArray", &boardFromArray);
    function("arrayFromBoard", &arrayFromBoard);
    function("isValidMove", &isValidMove);
}

// Utility functions for JS-WASM communication
board_t boardFromArray(const std::vector<int>& tiles) {
    board_t board = 0;
    for (int i = 0; i < 16; ++i) {
        board |= static_cast<board_t>(tiles[i]) << (i * 4);
    }
    return board;
}
```

### Strategy Implementation

```cpp
// Good: Consistent with existing patterns
class NewStrategy : public Strategy {
public:
    NewStrategy(HeuristicFunction heuristic, int depth)
        : heuristic_(heuristic), depth_(depth) {}

    int pick_move(board_t board) override {
        // Implementation following existing patterns
    }

private:
    HeuristicFunction heuristic_;
    int depth_;
};
```

## Performance Guidelines

### Throttling and Timing

```javascript
// Good: Proper throttling with change detection
async function tick() {
  if (!running || document.visibilityState !== "visible") {
    setTimeout(tick, 250);
    return;
  }

  const before = hash(read());
  send(direction);
  await new Promise((r) => setTimeout(r, 130)); // Throttle
  const after = hash(read());

  if (after !== before) {
    // Move successful, continue
  } else {
    // Try next direction
  }
}

// Bad: Busy waiting without throttling
function tick() {
  while (running) {
    send(direction); // Spam moves without waiting
  }
}
```

### Memory Management

```javascript
// Good: Cleanup and resource management
class GameController {
  constructor() {
    this.observer = new MutationObserver(this.handleChanges.bind(this));
  }

  destroy() {
    this.observer.disconnect();
    this.solver?.cleanup();
  }
}

// Bad: Memory leaks
class GameController {
  constructor() {
    setInterval(() => this.tick(), 100); // Never cleared
  }
}
```

## Testing Standards

### Unit Test Structure

```javascript
// Good: Focused, isolated tests
describe("BoardExtractor", () => {
  it("should extract 4x4 grid from play2048 DOM", () => {
    const mockDOM = createMockPlay2048DOM();
    const extractor = new BoardExtractor();
    const board = extractor.extract(mockDOM);

    expect(board).toEqual([
      [2, 0, 0, 4],
      [0, 8, 0, 0],
      [0, 0, 16, 0],
      [0, 0, 0, 2],
    ]);
  });
});

// Bad: Integration test disguised as unit test
describe("FullGameTest", () => {
  it("should play entire game", () => {
    // This belongs in integration tests
    const game = new FullGameSimulation();
    game.playUntilEnd(); // Too broad for unit test
  });
});
```

### Integration Test Patterns

```javascript
// Good: Real browser environment testing
describe("Extension Integration", () => {
  beforeEach(async () => {
    await loadTestPage("https://play2048.co");
    await injectExtension();
  });

  it("should detect game and make valid moves", async () => {
    const detector = await waitForDetection();
    expect(detector.isGameDetected()).toBe(true);

    const initialBoard = detector.readBoard();
    await detector.makeMove(0); // Up
    const newBoard = detector.readBoard();

    expect(newBoard).not.toEqual(initialBoard);
  });
});
```

## Security Best Practices

### Input Validation

```javascript
// Good: Validate all external input
function parseGameState(domElement) {
  const text = domElement.textContent?.trim();
  if (!text || !/^\d+$/.test(text)) {
    return 0; // Safe default
  }
  const value = parseInt(text, 10);
  return Math.min(value, 65536); // Cap at reasonable max
}

// Bad: Trust external input
function parseGameState(domElement) {
  return parseInt(domElement.textContent); // Can be NaN or malicious
}
```

### CSP Compliance

```javascript
// Good: Extension-safe patterns
function loadWASM() {
  const wasmUrl = chrome.runtime.getURL("solver.wasm");
  return WebAssembly.instantiateStreaming(fetch(wasmUrl));
}

// Bad: CSP-violating patterns
function loadWASM() {
  return eval("WebAssembly.instantiate(...)"); // Blocked by CSP
}
```

## Documentation Standards

### Code Comments

```javascript
// Good: Explain why, not what
/**
 * Throttles move execution to prevent overwhelming the game engine.
 * Many 2048 implementations can't handle rapid-fire moves and will
 * ignore subsequent moves until the animation completes.
 */
async function executeMove(direction) {
  // Implementation
}

// Bad: Obvious comments
/**
 * This function executes a move
 */
function executeMove(direction) {
  // Execute the move
}
```

### Interface Documentation

```typescript
/**
 * Adapter interface for different 2048 game implementations.
 * Each adapter handles site-specific DOM patterns and input methods.
 */
interface Adapter {
  /** Quick check if this adapter can handle the current page */
  canAttach(): boolean;

  /** Extract current game state as 4x4 number matrix (0 = empty) */
  readBoard(): number[][] | null;

  /** Send move command (0=Up, 1=Right, 2=Down, 3=Left) */
  sendMove(dir: 0 | 1 | 2 | 3): void;
}
```

## Build and Deployment

### File Organization

```
src/
├── extension/          # Browser extension files
│   ├── manifest.json   # MV3 manifest
│   ├── content.js      # Main content script
│   └── popup.html      # Settings UI
├── bookmarklet/        # Bookmarklet loader
│   └── loader.js       # Injection script
└── wasm/              # WebAssembly builds
    ├── solver.wasm     # Compiled solver
    └── solver.js       # JS bindings
```

### Version Management

- Use semantic versioning (MAJOR.MINOR.PATCH)
- Update manifest.json version on each release
- Tag releases in git with version numbers
- Maintain CHANGELOG.md with user-facing changes
