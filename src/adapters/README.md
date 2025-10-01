# Game Detection and Adapter System

This directory contains the core game detection and adapter system for the 2048 browser extension. The system uses the Adapter Registry pattern to automatically detect and interact with different 2048-like games on web pages.

## Architecture

### Base Components

- **`adapter.js`** - Base `Adapter` interface and utility functions
- **`adapter-registry.js`** - Registry system for automatic adapter selection
- **`index.js`** - Main exports and convenience functions

### Adapter Implementations

- **`play2048-adapter.js`** - Handles play2048.co and similar implementations
- **`generic-adapter.js`** - Heuristic-based fallback for unknown sites
- **`getmit-adapter.js`** - Specific adapter for https://mitchgu.github.io/GetMIT/

### Testing

- **`test-adapters.js`** - Browser console testing utilities

## Usage

### Basic Detection

```javascript
import { detectGame, isGameDetected } from "./adapters/index.js";

// Check if a game is detected
if (isGameDetected()) {
  const adapter = detectGame();
  console.log(`Found game using ${adapter.getName()}`);

  // Read current board state
  const board = adapter.readBoard();
  console.table(board);

  // Send a move
  adapter.sendMove(0); // Move up
}
```

### Manual Adapter Selection

```javascript
import { Play2048Adapter, GenericAdapter } from "./adapters/index.js";

// Try specific adapter
const play2048 = new Play2048Adapter();
if (play2048.canAttach()) {
  const board = play2048.readBoard();
  // ...
}
```

### Registry Management

```javascript
import { AdapterRegistry } from "./adapters/index.js";

const registry = new AdapterRegistry();

// Add custom adapter
registry.registerAdapter(MyCustomAdapter, 90);

// Get detection info
const info = registry.getAdapterInfo();
console.table(info);
```

## Adapter Interface

All adapters must implement the base `Adapter` interface:

```javascript
class MyAdapter extends Adapter {
  canAttach() {
    // Return true if this adapter can handle the current page
    return document.querySelector('.my-game') !== null;
  }

  readBoard() {
    // Return 4x4 number matrix or null
    // 0 represents empty cells
    return [[2, 0, 0, 4], [0, 8, 0, 0], ...];
  }

  sendMove(dir) {
    // Send move: 0=Up, 1=Right, 2=Down, 3=Left
    // Should dispatch keyboard/touch events
  }

  // Optional methods
  getScore() { return null; }
  isGameOver() { return false; }
}
```

## Direction Constants

```javascript
import { Direction } from "./adapters/index.js";

Direction.UP; // 0
Direction.RIGHT; // 1
Direction.DOWN; // 2
Direction.LEFT; // 3
```

## Board Utilities

```javascript
import { BoardUtils } from "./adapters/index.js";

// Create empty board
const board = BoardUtils.createEmptyBoard();

// Hash board for change detection
const hash = BoardUtils.hashBoard(board);

// Validate board structure
const isValid = BoardUtils.isValidBoard(board);

// Parse tile values safely
const value = BoardUtils.parseTileValue("2048");
```

## Testing

Load `test-adapters.js` in the browser console:

```javascript
// Test detection on current page
testAdapterSystem();

// Test move execution (use carefully!)
testMove(0); // Test up move
```

## Site Compatibility

### Supported Patterns

1. **play2048.co style** - `.tile-container`, `.tile` elements with position classes
2. **Generic 4x4 grids** - Heuristic detection of numeric grids
3. **GetMIT specific** - Custom patterns for the target site

### Adding New Sites

1. Create new adapter class extending `Adapter`
2. Implement required methods (`canAttach`, `readBoard`, `sendMove`)
3. Register with appropriate priority in `AdapterRegistry`
4. Test with `testAdapterSystem()`

### Detection Priority

Adapters are tested in priority order:

1. **GetMITAdapter** (100) - Specific to target site
2. **Play2048Adapter** (80) - Common pattern
3. **GenericAdapter** (10) - Fallback heuristic

## Error Handling

- All methods include try-catch blocks for graceful degradation
- Invalid board states return `null`
- Failed move execution logs warnings but doesn't throw
- Registry continues testing adapters if one fails

## Performance

- Detection results are cached for 2 seconds
- Generic adapter caches DOM scans for 1 second
- Minimal DOM queries and efficient selectors
- Lazy instantiation of adapter instances
