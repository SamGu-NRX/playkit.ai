---
inclusion: fileMatch
fileMatchPattern: "*.cpp|*.hpp|*.js|*.ts|*wasm*|*solver*"
---

# WebAssembly Integration Guidelines

## Overview

This project integrates the existing C++ 2048 solver with browser environments via WebAssembly. The integration maintains performance parity with the native C++ implementation while providing a JavaScript-friendly interface.

## Build Configuration

### Emscripten Setup

```bash
# Install Emscripten
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh

# Build solver
emcc solver.cpp -o solver.js \
  -s WASM=1 \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -O3 \
  --bind
```

### Build Targets

- **Development**: Unoptimized with debug symbols (`-g`)
- **Production**: Optimized for size and speed (`-O3 -s ASSERTIONS=0`)
- **Bookmarklet**: Inline WASM for CSP compatibility

## C++ Export Patterns

### Enhanced Export Bindings

```cpp
// export_players.cpp - Enhanced for browser integration
#include <emscripten/bind.h>
#include "game.hpp"
#include "strategies/ExpectimaxStrategy.hpp"
#include "heuristics.hpp"

using namespace emscripten;

// Board conversion utilities
board_t boardFromArray(const std::vector<int>& tiles) {
    board_t board = 0;
    for (int i = 0; i < 16; ++i) {
        board |= static_cast<board_t>(tiles[i]) << (i * 4);
    }
    return board;
}

std::vector<int> arrayFromBoard(board_t board) {
    std::vector<int> tiles(16);
    for (int i = 0; i < 16; ++i) {
        tiles[i] = (board >> (i * 4)) & 0xF;
    }
    return tiles;
}

// Game state utilities
int getScore(board_t board) {
    return score_board(board);
}

int getMaxTile(board_t board) {
    int max_tile = 0;
    for (int i = 0; i < 16; ++i) {
        int tile = (board >> (i * 4)) & 0xF;
        max_tile = std::max(max_tile, tile);
    }
    return 1 << max_tile; // Convert from log2 representation
}

bool isGameOver(board_t board) {
    GameSimulator sim;
    return sim.game_over(board);
}

bool isValidMove(board_t board, int direction) {
    GameSimulator sim;
    return board != sim.make_move(board, direction);
}

board_t makeMove(board_t board, int direction) {
    GameSimulator sim;
    return sim.make_move(board, direction);
}

// Strategy factory
class StrategyWrapper {
private:
    std::unique_ptr<Strategy> strategy_;

public:
    StrategyWrapper(const std::string& type, const std::string& heuristic, int depth = 4) {
        HeuristicFunction hfunc = get_heuristic(heuristic);

        if (type == "expectimax") {
            strategy_ = std::make_unique<ExpectimaxDepthStrategy>(hfunc, depth);
        } else if (type == "monte_carlo") {
            strategy_ = std::make_unique<MonteCarloPlayer>(1000); // Default trials
        } else {
            // Fallback to random
            strategy_ = std::make_unique<RandomPlayer>();
        }
    }

    int pickMove(board_t board) {
        return strategy_->pick_move(board);
    }

    double evaluateBoard(board_t board) {
        // Use heuristic evaluation if available
        return score_board(board); // Fallback to score
    }
};

EMSCRIPTEN_BINDINGS(enhanced_solver) {
    // Board utilities
    function("boardFromArray", &boardFromArray);
    function("arrayFromBoard", &arrayFromBoard);
    function("getScore", &getScore);
    function("getMaxTile", &getMaxTile);
    function("isGameOver", &isGameOver);
    function("isValidMove", &isValidMove);
    function("makeMove", &makeMove);

    // Strategy wrapper
    class_<StrategyWrapper>("StrategyWrapper")
        .constructor<std::string, std::string, int>()
        .function("pickMove", &StrategyWrapper::pickMove)
        .function("evaluateBoard", &StrategyWrapper::evaluateBoard);

    // Vector bindings for board conversion
    register_vector<int>("VectorInt");
}
```

### Heuristic Integration

```cpp
// heuristics.hpp - Ensure all heuristics are exportable
HeuristicFunction get_heuristic(const std::string& name) {
    if (name == "corner") return corner_building;
    if (name == "monotonicity") return monotonicity;
    if (name == "wall_gap") return wall_gap_building;
    if (name == "full_wall") return full_wall_building;
    if (name == "strict_wall") return strict_wall_building;
    if (name == "score") return score_heuristic;
    if (name == "merge") return merge_heuristic;
    return score_heuristic; // Default fallback
}
```

## JavaScript Integration Layer

### WASM Loader

```javascript
class WASMSolver {
  constructor() {
    this.module = null;
    this.strategy = null;
    this.initialized = false;
  }

  async initialize() {
    try {
      // Load WASM module
      if (typeof chrome !== "undefined" && chrome.runtime) {
        // Extension context
        const wasmUrl = chrome.runtime.getURL("solver.wasm");
        this.module = await import(chrome.runtime.getURL("solver.js"));
        await this.module.default();
      } else {
        // Bookmarklet context - inline WASM
        this.module = await import("./solver.js");
        await this.module.default();
      }

      this.initialized = true;
      console.log("WASM solver initialized");
    } catch (error) {
      console.error("WASM initialization failed:", error);
      throw error;
    }
  }

  setStrategy(type, heuristic, params = {}) {
    if (!this.initialized) throw new Error("Solver not initialized");

    const depth = params.depth || 4;
    this.strategy = new this.module.StrategyWrapper(type, heuristic, depth);
  }

  pickMove(board) {
    if (!this.strategy) throw new Error("Strategy not set");

    // Convert JS array to C++ board representation
    const flatBoard = board.flat();
    const cppBoard = this.module.boardFromArray(flatBoard);

    // Get move from C++ strategy
    return this.strategy.pickMove(cppBoard);
  }

  evaluateBoard(board) {
    if (!this.strategy) return 0;

    const flatBoard = board.flat();
    const cppBoard = this.module.boardFromArray(flatBoard);

    return this.strategy.evaluateBoard(cppBoard);
  }

  getBoardInfo(board) {
    if (!this.initialized) return null;

    const flatBoard = board.flat();
    const cppBoard = this.module.boardFromArray(flatBoard);

    return {
      score: this.module.getScore(cppBoard),
      maxTile: this.module.getMaxTile(cppBoard),
      gameOver: this.module.isGameOver(cppBoard),
    };
  }

  isValidMove(board, direction) {
    if (!this.initialized) return false;

    const flatBoard = board.flat();
    const cppBoard = this.module.boardFromArray(flatBoard);

    return this.module.isValidMove(cppBoard, direction);
  }
}
```

### Fallback Strategy

```javascript
class NaiveSolver {
  constructor() {
    this.directionBias = 2; // Default to Down
  }

  setStrategy(type, heuristic, params = {}) {
    // Naive solver ignores complex strategies
    this.directionBias = params.directionBias || 2;
  }

  pickMove(board) {
    // Simple direction priority: keep max tile in corner
    const maxTile = Math.max(...board.flat());
    const maxPos = this.findMaxTilePosition(board, maxTile);

    // Prefer moves that keep max tile in corner
    const priorities = this.getDirectionPriorities(maxPos);

    for (const dir of priorities) {
      if (this.wouldChangeBoard(board, dir)) {
        return dir;
      }
    }

    // Random fallback
    return Math.floor(Math.random() * 4);
  }

  findMaxTilePosition(board, maxTile) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === maxTile) {
          return { row: r, col: c };
        }
      }
    }
    return { row: 0, col: 0 };
  }

  getDirectionPriorities(maxPos) {
    // Keep max tile in corner - prefer moves toward corners
    if (maxPos.row <= 1 && maxPos.col <= 1) {
      return [0, 3, 1, 2]; // Up, Left, Right, Down
    } else if (maxPos.row <= 1 && maxPos.col >= 2) {
      return [0, 1, 3, 2]; // Up, Right, Left, Down
    } else if (maxPos.row >= 2 && maxPos.col <= 1) {
      return [2, 3, 1, 0]; // Down, Left, Right, Up
    } else {
      return [2, 1, 3, 0]; // Down, Right, Left, Up
    }
  }

  wouldChangeBoard(board, direction) {
    // Simple simulation - check if any tiles would move
    const newBoard = this.simulateMove(board, direction);
    return JSON.stringify(board) !== JSON.stringify(newBoard);
  }

  simulateMove(board, direction) {
    // Simplified move simulation
    const newBoard = board.map((row) => [...row]);

    switch (direction) {
      case 0: // Up
        for (let c = 0; c < 4; c++) {
          const column = [
            newBoard[0][c],
            newBoard[1][c],
            newBoard[2][c],
            newBoard[3][c],
          ];
          const shifted = this.shiftArray(column);
          for (let r = 0; r < 4; r++) {
            newBoard[r][c] = shifted[r];
          }
        }
        break;
      case 1: // Right
        for (let r = 0; r < 4; r++) {
          newBoard[r] = this.shiftArray(newBoard[r].reverse()).reverse();
        }
        break;
      case 2: // Down
        for (let c = 0; c < 4; c++) {
          const column = [
            newBoard[3][c],
            newBoard[2][c],
            newBoard[1][c],
            newBoard[0][c],
          ];
          const shifted = this.shiftArray(column);
          for (let r = 0; r < 4; r++) {
            newBoard[3 - r][c] = shifted[r];
          }
        }
        break;
      case 3: // Left
        for (let r = 0; r < 4; r++) {
          newBoard[r] = this.shiftArray(newBoard[r]);
        }
        break;
    }

    return newBoard;
  }

  shiftArray(arr) {
    // Remove zeros and merge adjacent equal values
    const nonZero = arr.filter((x) => x !== 0);
    const merged = [];

    for (let i = 0; i < nonZero.length; i++) {
      if (i < nonZero.length - 1 && nonZero[i] === nonZero[i + 1]) {
        merged.push(nonZero[i] * 2);
        i++; // Skip next element
      } else {
        merged.push(nonZero[i]);
      }
    }

    // Pad with zeros
    while (merged.length < 4) {
      merged.push(0);
    }

    return merged;
  }
}
```

### Solver Factory

```javascript
class SolverFactory {
  static async createSolver() {
    try {
      const wasmSolver = new WASMSolver();
      await wasmSolver.initialize();
      return wasmSolver;
    } catch (error) {
      console.warn("WASM solver failed, using fallback:", error);
      return new NaiveSolver();
    }
  }
}
```

## Performance Considerations

### Memory Management

- Use `ALLOW_MEMORY_GROWTH=1` for dynamic allocation
- Implement proper cleanup in strategy destructors
- Monitor memory usage in long-running games

### Optimization Flags

```bash
# Production build
emcc solver.cpp -o solver.js \
  -s WASM=1 \
  -O3 \
  -s ASSERTIONS=0 \
  -s DISABLE_EXCEPTION_CATCHING=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="SolverModule" \
  --bind
```

### Benchmarking

```javascript
// Performance comparison between WASM and native
async function benchmarkSolver() {
  const wasmSolver = await SolverFactory.createSolver();
  const testBoard = [
    [2, 4, 8, 16],
    [4, 8, 16, 32],
    [8, 16, 32, 64],
    [16, 32, 64, 128],
  ];

  const iterations = 1000;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    wasmSolver.pickMove(testBoard);
  }

  const end = performance.now();
  const avgTime = (end - start) / iterations;

  console.log(`Average move calculation: ${avgTime.toFixed(2)}ms`);
}
```

## Error Handling

### WASM Load Failures

```javascript
async function initializeSolver() {
  try {
    const solver = new WASMSolver();
    await solver.initialize();
    return solver;
  } catch (error) {
    if (error.message.includes("CSP")) {
      console.warn("CSP blocked WASM, using extension build");
      // Retry with extension context
    } else if (error.message.includes("network")) {
      console.warn("Network error loading WASM, using cached version");
      // Try cached/inline version
    } else {
      console.error("WASM initialization failed:", error);
      // Fall back to naive solver
    }

    return new NaiveSolver();
  }
}
```

### Strategy Validation

```javascript
function validateStrategy(type, heuristic, params) {
  const validTypes = ["expectimax", "monte_carlo", "minimax", "random"];
  const validHeuristics = [
    "corner",
    "monotonicity",
    "wall_gap",
    "score",
    "merge",
  ];

  if (!validTypes.includes(type)) {
    throw new Error(`Invalid strategy type: ${type}`);
  }

  if (!validHeuristics.includes(heuristic)) {
    throw new Error(`Invalid heuristic: ${heuristic}`);
  }

  if (params.depth && (params.depth < 1 || params.depth > 8)) {
    throw new Error(`Invalid depth: ${params.depth} (must be 1-8)`);
  }
}
```

## Testing Integration

### Unit Tests

```javascript
describe("WASM Integration", () => {
  let solver;

  beforeEach(async () => {
    solver = await SolverFactory.createSolver();
  });

  it("should convert board representations correctly", () => {
    const jsBoard = [
      [2, 4, 0, 0],
      [0, 8, 0, 0],
      [0, 0, 16, 0],
      [0, 0, 0, 32],
    ];

    const info = solver.getBoardInfo(jsBoard);
    expect(info.maxTile).toBe(32);
    expect(info.score).toBeGreaterThan(0);
  });

  it("should validate moves correctly", () => {
    const board = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];

    expect(solver.isValidMove(board, 3)).toBe(true); // Left - can merge
    expect(solver.isValidMove(board, 1)).toBe(false); // Right - no change
  });
});
```

### Performance Tests

```javascript
describe("Performance", () => {
  it("should calculate moves within acceptable time", async () => {
    const solver = await SolverFactory.createSolver();
    const complexBoard = generateComplexBoard();

    const start = performance.now();
    const move = solver.pickMove(complexBoard);
    const end = performance.now();

    expect(end - start).toBeLessThan(100); // Under 100ms
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(4);
  });
});
```
