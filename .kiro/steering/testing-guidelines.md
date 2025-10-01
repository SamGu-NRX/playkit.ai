---
inclusion: fileMatch
fileMatchPattern: "*test*|*spec*|*.test.*|*.spec.*|*benchmark*"
---

# Testing Guidelines and Patterns

## Testing Strategy Overview

### Test Pyramid Structure

- **Unit Tests (70%)**: Core algorithms, utilities, and isolated components
- **Integration Tests (20%)**: Adapter functionality, WASM integration, cross-component interaction
- **End-to-End Tests (10%)**: Full browser automation, real game sites

### Test Categories

1. **Algorithm Tests**: C++ solver logic, move calculation, board evaluation
2. **Adapter Tests**: Game detection, board extraction, move execution
3. **Extension Tests**: Browser API integration, message passing, storage
4. **Performance Tests**: WASM vs native benchmarks, memory usage, timing
5. **Cross-Browser Tests**: Compatibility across Chrome, Firefox, Safari

## Unit Testing Patterns

### Algorithm Testing

```javascript
describe("BoardUtils", () => {
  describe("boardFromArray", () => {
    it("should convert 4x4 array to bitwise representation", () => {
      const board = [
        [2, 4, 0, 0],
        [0, 8, 0, 0],
        [0, 0, 16, 0],
        [0, 0, 0, 32],
      ];

      const bitBoard = BoardUtils.boardFromArray(board.flat());
      const reconstructed = BoardUtils.arrayFromBoard(bitBoard);

      expect(reconstructed).toEqual([
        1, 2, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 5,
      ]);
      // Values are in log2 representation: 2^1=2, 2^2=4, 2^3=8, etc.
    });

    it("should handle empty board", () => {
      const emptyBoard = Array(16).fill(0);
      const bitBoard = BoardUtils.boardFromArray(emptyBoard);

      expect(bitBoard).toBe(0n);
    });

    it("should handle maximum tile values", () => {
      const maxBoard = Array(16).fill(65536); // 2^16
      const bitBoard = BoardUtils.boardFromArray(maxBoard);
      const reconstructed = BoardUtils.arrayFromBoard(bitBoard);

      // Should cap at 2^15 due to 4-bit limitation
      expect(reconstructed.every((val) => val <= 15)).toBe(true);
    });
  });

  describe("isValidMove", () => {
    it("should detect valid moves correctly", () => {
      const board = [
        [2, 2, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];

      expect(BoardUtils.isValidMove(board, 3)).toBe(true); // Left - can merge
      expect(BoardUtils.isValidMove(board, 1)).toBe(false); // Right - no change
      expect(BoardUtils.isValidMove(board, 0)).toBe(false); // Up - no change
      expect(BoardUtils.isValidMove(board, 2)).toBe(true); // Down - can move
    });

    it("should handle full board", () => {
      const fullBoard = [
        [2, 4, 8, 16],
        [32, 64, 128, 256],
        [512, 1024, 2048, 4096],
        [8192, 16384, 32768, 65536],
      ];

      // No adjacent equal values - no valid moves
      expect(
        [0, 1, 2, 3].every((dir) => !BoardUtils.isValidMove(fullBoard, dir))
      ).toBe(true);
    });
  });
});

describe("MoveSimulator", () => {
  let simulator;

  beforeEach(() => {
    simulator = new MoveSimulator();
  });

  it("should simulate left move correctly", () => {
    const board = [
      [2, 2, 4, 4],
      [0, 8, 0, 8],
      [16, 0, 16, 0],
      [0, 0, 0, 0],
    ];

    const result = simulator.simulateMove(board, 3); // Left

    expect(result).toEqual([
      [4, 8, 0, 0], // 2+2=4, 4+4=8
      [16, 0, 0, 0], // 8+8=16
      [32, 0, 0, 0], // 16+16=32
      [0, 0, 0, 0],
    ]);
  });

  it("should handle cascading merges", () => {
    const board = [
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];

    const result = simulator.simulateMove(board, 3); // Left

    // Should merge left-to-right: (2+2=4), (2+2=4) -> [4, 4, 0, 0]
    // NOT cascading merge: 4+4=8
    expect(result[0]).toEqual([4, 4, 0, 0]);
  });
});
```

### Adapter Testing

```javascript
describe("Play2048Adapter", () => {
  let adapter;
  let mockDOM;

  beforeEach(() => {
    adapter = new Play2048Adapter();
    mockDOM = createMockPlay2048DOM();
    document.body.appendChild(mockDOM);
  });

  afterEach(() => {
    document.body.removeChild(mockDOM);
  });

  describe("canAttach", () => {
    it("should detect play2048-style games", () => {
      expect(adapter.canAttach()).toBe(true);
    });

    it("should reject incompatible pages", () => {
      document.body.innerHTML = "<div>Not a 2048 game</div>";
      expect(adapter.canAttach()).toBe(false);
    });
  });

  describe("readBoard", () => {
    it("should extract board state correctly", () => {
      // Mock DOM with specific tile positions
      const container = document.querySelector(".tile-container");
      container.innerHTML = `
        <div class="tile tile-2 tile-position-1-1"></div>
        <div class="tile tile-4 tile-position-2-1"></div>
        <div class="tile tile-8 tile-position-1-2"></div>
      `;

      const board = adapter.readBoard();

      expect(board).toEqual([
        [2, 4, 0, 0],
        [8, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]);
    });

    it("should handle stacked tiles", () => {
      const container = document.querySelector(".tile-container");
      container.innerHTML = `
        <div class="tile tile-2 tile-position-1-1"></div>
        <div class="tile tile-4 tile-position-1-1 tile-merged"></div>
      `;

      const board = adapter.readBoard();

      // Should keep highest value (4) when tiles are stacked
      expect(board[0][0]).toBe(4);
    });
  });

  describe("sendMove", () => {
    it("should dispatch keyboard events", () => {
      const eventSpy = jest.spyOn(document.body, "dispatchEvent");

      adapter.sendMove(0); // Up

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "keydown",
          key: "ArrowUp",
          keyCode: 38,
        })
      );
    });

    it("should simulate touch events as fallback", () => {
      const gameContainer = document.querySelector(".game-container");
      const touchSpy = jest.spyOn(gameContainer, "dispatchEvent");

      adapter.sendMove(1); // Right

      expect(touchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "touchstart",
        })
      );
    });
  });
});

function createMockPlay2048DOM() {
  const container = document.createElement("div");
  container.innerHTML = `
    <div class="game-container">
      <div class="tile-container"></div>
      <div class="score-container">1234</div>
    </div>
  `;
  return container;
}
```

### WASM Integration Testing

```javascript
describe("WASMSolver", () => {
  let solver;

  beforeEach(async () => {
    solver = new WASMSolver();
    await solver.initialize();
  });

  afterEach(() => {
    if (solver) {
      solver.cleanup();
    }
  });

  it("should initialize successfully", () => {
    expect(solver.initialized).toBe(true);
    expect(solver.module).toBeDefined();
  });

  it("should set strategy correctly", () => {
    expect(() => {
      solver.setStrategy("expectimax", "corner", { depth: 4 });
    }).not.toThrow();

    expect(solver.strategy).toBeDefined();
  });

  it("should calculate moves within time limit", async () => {
    solver.setStrategy("expectimax", "corner", { depth: 3 });

    const board = [
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 128],
    ];

    const start = performance.now();
    const move = solver.pickMove(board);
    const end = performance.now();

    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(4);
    expect(end - start).toBeLessThan(1000); // Under 1 second
  });

  it("should match C++ solver results", async () => {
    // Test against known good results from C++ implementation
    const testCases = [
      {
        board: [
          [2, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        expectedMove: 2, // Down (corner strategy)
        strategy: "expectimax",
        heuristic: "corner",
      },
      {
        board: [
          [2, 4, 8, 16],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        expectedMove: 2, // Down
        strategy: "expectimax",
        heuristic: "corner",
      },
    ];

    for (const testCase of testCases) {
      solver.setStrategy(testCase.strategy, testCase.heuristic, { depth: 2 });
      const move = solver.pickMove(testCase.board);
      expect(move).toBe(testCase.expectedMove);
    }
  });

  it("should handle invalid inputs gracefully", () => {
    expect(() => {
      solver.setStrategy("invalid_strategy", "corner");
    }).toThrow();

    expect(() => {
      solver.pickMove(null);
    }).toThrow();

    expect(() => {
      solver.pickMove([[1, 2, 3]]); // Invalid board size
    }).toThrow();
  });
});
```

## Integration Testing

### End-to-End Game Testing

```javascript
describe("Full Game Integration", () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: false, // Set to true for CI
      args: ["--load-extension=./src/extension"],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  it("should detect and play 2048 on play2048.co", async () => {
    await page.goto("https://play2048.co");

    // Wait for game to load
    await page.waitForSelector(".tile-container");

    // Extension should inject HUD
    await page.waitForSelector("#t48-host", { timeout: 5000 });

    // Click detect button
    await page.click("#t48-detect");

    // Verify detection
    const logText = await page.$eval("#t48-log", (el) => el.textContent);
    expect(logText).toContain("Adapter attached");

    // Start auto-solve
    await page.click("#t48-solve");

    // Wait for some moves
    await page.waitForTimeout(5000);

    // Verify game is progressing
    const tiles = await page.$$(".tile");
    expect(tiles.length).toBeGreaterThan(2); // Should have more tiles

    // Check for higher value tiles
    const tileValues = await page.$$eval(".tile", (tiles) =>
      tiles.map((tile) => {
        const match = tile.className.match(/tile-(\d+)/);
        return match ? parseInt(match[1]) : 0;
      })
    );

    const maxTile = Math.max(...tileValues);
    expect(maxTile).toBeGreaterThan(4); // Should achieve higher than starting tiles
  });

  it("should handle game over gracefully", async () => {
    await page.goto("https://play2048.co");
    await page.waitForSelector(".tile-container");

    // Inject a nearly full board state for quick game over
    await page.evaluate(() => {
      // Mock a game over scenario
      const gameManager = window.GameManager;
      if (gameManager) {
        gameManager.grid.cells = [
          [{ value: 2 }, { value: 4 }, { value: 8 }, { value: 16 }],
          [{ value: 32 }, { value: 64 }, { value: 128 }, { value: 256 }],
          [{ value: 512 }, { value: 1024 }, { value: 2048 }, { value: 4096 }],
          [{ value: 8192 }, { value: 16384 }, { value: 32768 }, null],
        ];
        gameManager.actuate();
      }
    });

    await page.click("#t48-solve");

    // Wait for game over detection
    await page.waitForSelector(".game-over", { timeout: 10000 });

    // Verify solver stops
    const solveButton = await page.$("#t48-solve");
    const isActive = await solveButton.evaluate((el) => el.dataset.on === "1");
    expect(isActive).toBe(false);
  });
});
```

### Cross-Browser Testing

```javascript
describe("Cross-Browser Compatibility", () => {
  const browsers = ["chrome", "firefox", "safari"];

  browsers.forEach((browserName) => {
    describe(`${browserName} compatibility`, () => {
      let browser;
      let page;

      beforeAll(async () => {
        browser = await getBrowserInstance(browserName);
      });

      afterAll(async () => {
        await browser.close();
      });

      it("should load extension correctly", async () => {
        page = await browser.newPage();
        await page.goto("https://play2048.co");

        // Check if extension APIs are available
        const hasExtensionAPI = await page.evaluate(() => {
          return (
            typeof chrome !== "undefined" &&
            typeof chrome.runtime !== "undefined"
          );
        });

        expect(hasExtensionAPI).toBe(true);
      });

      it("should inject content script", async () => {
        page = await browser.newPage();
        await page.goto("https://play2048.co");

        await page.waitForSelector("#t48-host", { timeout: 5000 });

        const hudExists = (await page.$("#t48-host")) !== null;
        expect(hudExists).toBe(true);
      });
    });
  });

  async function getBrowserInstance(browserName) {
    switch (browserName) {
      case "chrome":
        return puppeteer.launch({
          args: ["--load-extension=./src/extension"],
        });

      case "firefox":
        return puppeteer.launch({
          product: "firefox",
          args: ["--load-extension=./src/extension"],
        });

      case "safari":
        // Safari testing requires different setup
        return puppeteer.launch({
          executablePath: "/Applications/Safari.app/Contents/MacOS/Safari",
        });

      default:
        throw new Error(`Unknown browser: ${browserName}`);
    }
  }
});
```

## Performance Testing

### Benchmarking

```javascript
describe("Performance Benchmarks", () => {
  let wasmSolver;
  let nativeSolver;

  beforeAll(async () => {
    wasmSolver = new WASMSolver();
    await wasmSolver.initialize();
    wasmSolver.setStrategy("expectimax", "corner", { depth: 4 });

    nativeSolver = new NaiveSolver();
  });

  it("should calculate moves within acceptable time", async () => {
    const complexBoard = [
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 2048, 4096],
      [8192, 16384, 0, 0],
    ];

    const iterations = 100;
    const times = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      wasmSolver.pickMove(complexBoard);
      const end = performance.now();
      times.push(end - start);
    }

    const avgTime = times.reduce((a, b) => a + b) / times.length;
    const maxTime = Math.max(...times);

    console.log(`Average time: ${avgTime.toFixed(2)}ms`);
    console.log(`Max time: ${maxTime.toFixed(2)}ms`);

    expect(avgTime).toBeLessThan(100); // Under 100ms average
    expect(maxTime).toBeLessThan(500); // Under 500ms worst case
  });

  it("should compare WASM vs naive performance", async () => {
    const testBoard = [
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 0],
    ];

    const iterations = 1000;

    // Benchmark WASM solver
    const wasmStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      wasmSolver.pickMove(testBoard);
    }
    const wasmTime = performance.now() - wasmStart;

    // Benchmark naive solver
    const naiveStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      nativeSolver.pickMove(testBoard);
    }
    const naiveTime = performance.now() - naiveStart;

    console.log(
      `WASM: ${wasmTime.toFixed(2)}ms total, ${(wasmTime / iterations).toFixed(
        2
      )}ms avg`
    );
    console.log(
      `Naive: ${naiveTime.toFixed(2)}ms total, ${(
        naiveTime / iterations
      ).toFixed(2)}ms avg`
    );

    // WASM should be significantly faster for complex calculations
    // But naive might be faster for simple cases due to overhead
    expect(wasmTime).toBeLessThan(naiveTime * 10); // At most 10x slower (accounting for overhead)
  });

  it("should monitor memory usage", async () => {
    const initialMemory = performance.memory?.usedJSHeapSize || 0;

    // Run many calculations
    const testBoard = generateRandomBoard();
    for (let i = 0; i < 10000; i++) {
      wasmSolver.pickMove(testBoard);
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const finalMemory = performance.memory?.usedJSHeapSize || 0;
    const memoryIncrease = finalMemory - initialMemory;

    console.log(
      `Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`
    );

    // Should not leak significant memory
    expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // Under 50MB
  });
});

function generateRandomBoard() {
  const board = Array.from({ length: 4 }, () => Array(4).fill(0));
  const values = [2, 4, 8, 16, 32, 64, 128, 256];

  // Fill ~60% of board randomly
  for (let i = 0; i < 10; i++) {
    const row = Math.floor(Math.random() * 4);
    const col = Math.floor(Math.random() * 4);
    if (board[row][col] === 0) {
      board[row][col] = values[Math.floor(Math.random() * values.length)];
    }
  }

  return board;
}
```

## Test Utilities and Helpers

### Mock Factories

```javascript
class TestUtils {
  static createMockBoard(pattern = "empty") {
    switch (pattern) {
      case "empty":
        return Array.from({ length: 4 }, () => Array(4).fill(0));

      case "simple":
        return [
          [2, 4, 0, 0],
          [0, 8, 0, 0],
          [0, 0, 16, 0],
          [0, 0, 0, 32],
        ];

      case "complex":
        return [
          [2, 4, 8, 16],
          [32, 64, 128, 256],
          [512, 1024, 2048, 4096],
          [8192, 16384, 32768, 0],
        ];

      case "full":
        return [
          [2, 4, 8, 16],
          [32, 64, 128, 256],
          [512, 1024, 2048, 4096],
          [8192, 16384, 32768, 65536],
        ];

      default:
        throw new Error(`Unknown pattern: ${pattern}`);
    }
  }

  static createMockAdapter(boardState = null) {
    return {
      canAttach: jest.fn(() => true),
      readBoard: jest.fn(() => boardState || this.createMockBoard("simple")),
      sendMove: jest.fn(),
      getGameInfo: jest.fn(() => ({
        score: 1234,
        gameOver: false,
        won: false,
      })),
    };
  }

  static async waitFor(condition, timeout = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (await condition()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Condition not met within ${timeout}ms`);
  }

  static simulateKeyPress(key, target = document.body) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });

    target.dispatchEvent(event);
  }

  static simulateTouch(element, direction) {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const deltas = [
      { x: 0, y: -100 }, // Up
      { x: 100, y: 0 }, // Right
      { x: 0, y: 100 }, // Down
      { x: -100, y: 0 }, // Left
    ];

    const delta = deltas[direction];

    const touchStart = new Touch({
      identifier: 1,
      target: element,
      clientX: centerX,
      clientY: centerY,
    });

    const touchEnd = new Touch({
      identifier: 1,
      target: element,
      clientX: centerX + delta.x,
      clientY: centerY + delta.y,
    });

    element.dispatchEvent(
      new TouchEvent("touchstart", {
        touches: [touchStart],
        changedTouches: [touchStart],
      })
    );

    element.dispatchEvent(
      new TouchEvent("touchend", {
        touches: [],
        changedTouches: [touchEnd],
      })
    );
  }
}
```

## CI/CD Integration

### Jest Configuration

```javascript
// jest.config.js
module.exports = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/test/setup.js"],
  testMatch: ["<rootDir>/test/**/*.test.js", "<rootDir>/src/**/*.test.js"],
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/**/*.test.js",
    "!src/extension/manifest.json",
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  testTimeout: 30000, // 30 seconds for integration tests
  maxWorkers: 4,
};
```

### GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test Suite

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [16, 18, 20]
        browser: [chrome, firefox]

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}

      - name: Install dependencies
        run: npm ci

      - name: Build WASM
        run: npm run build:wasm

      - name: Run unit tests
        run: npm test -- --coverage

      - name: Run integration tests
        run: npm run test:integration
        env:
          BROWSER: ${{ matrix.browser }}

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
```
