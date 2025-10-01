---
inclusion: fileMatch
fileMatchPattern: "*adapter*|*detect*|*game*|*board*|*dom*"
---

# Game Detection and DOM Interaction Patterns

## Adapter Architecture

### Adapter Interface Contract

```typescript
interface Adapter {
  /** Quick compatibility check for current page */
  canAttach(): boolean;

  /** Extract current game state as 4x4 number matrix (0 = empty) */
  readBoard(): number[][] | null;

  /** Execute move command (0=Up, 1=Right, 2=Down, 3=Left) */
  sendMove(dir: 0 | 1 | 2 | 3): void;

  /** Optional: Get additional game info */
  getGameInfo?(): {
    score?: number;
    gameOver?: boolean;
    won?: boolean;
  };
}
```

### Adapter Registration Pattern

```javascript
class AdapterRegistry {
  constructor() {
    this.adapters = [];
    this.currentAdapter = null;
  }

  register(adapter) {
    this.adapters.push(adapter);
  }

  detect() {
    this.currentAdapter = null;

    for (const adapter of this.adapters) {
      try {
        if (adapter.canAttach()) {
          this.currentAdapter = adapter;
          console.log("Adapter attached:", adapter.constructor.name);
          return adapter;
        }
      } catch (error) {
        console.warn("Adapter check failed:", error);
      }
    }

    console.log("No compatible adapter found");
    return null;
  }

  getCurrentAdapter() {
    return this.currentAdapter;
  }
}
```

## Site-Specific Adapters

### Play2048.co Adapter

```javascript
class Play2048Adapter {
  canAttach() {
    return !!(
      document.querySelector('.tile-container') &&
      document.querySelector('.tile-container .tile')
    );
  }

  readBoard() {
    const container = document.querySelector('.tile-container');
    if (!container) return null;

    // Initialize empty 4x4 grid
    const cells = Array.from({length: 4}, () => Array(4).fill(0));

    // Extract tiles from DOM
    container.querySelectorAll('.tile').forEach(tile => {
      const classes = tile.className;

      // Extract tile value (tile-2, tile-4, etc.)
      const valueMatch = classes.match(/tile-(\d+)/);
      if (!valueMatch) return;

      // Extract position (tile-position-1-2 = col 1, row 2)
      const posMatch = classes.match(/tile-position-(\d+)-(\d+)/);
      if (!posMatch) return;

      const value = parseInt(valueMatch[1], 10);
      const col = parseInt(posMatch[1], 10) - 1; // Convert to 0-based
      const row = parseInt(posMatch[2], 10) - 1;

      // Handle stacked tiles (keep highest value)
      if (row >= 0 && row < 4 && col >= 0 && col < 4) {
        cells[row][col] = Math.max(cells[row][col], value);
      }
    });

    return cells;
  }

  sendMove(direction) {
    const keys = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
    const keyCodes = [38, 39, 40, 37];

    const keyEvent = new KeyboardEvent('keydown', {
      key: keys[direction],
      keyCode: keyCodes[direction],
      which: keyCodes[direction],
      bubbles: true,
      cancelable: true
    });

    // Send to game container or document
    const target = document.querySelector('.game-container') || document.body;
    target.dispatchEvent(keyEvent);

    // Fallback: touch simulation for mobile
    this.simulateSwipe(direction);
  }

  simulateSwipe(direction) {
    try {
      const gameContainer = document.querySelector('.game-container');
      if (!gameContainer) return;

      const rect = gameContainer.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Swipe deltas: Up, Right, Down, Left
      const deltas = [
        { x: 0, y: -100 },   // Up
        { x: 100, y: 0 },    // Right
        { x: 0, y: 100 },    // Down
        { x: -100, y: 0 }    // Left
      ];

      const delta = deltas[direction];
      const startX = centerX;
      const startY = centerY;
      const endX = centerX + delta.x;
      const endY = centerY + delta.y;

      // Create touch events
      const touchStart = new Touch({
        identifier: 1,
        target: gameContainer,
        clientX: startX,
        clientY: startY
      });

      const touchEnd = new Touch({
        identifier: 1,
        target: gameContainer,
        clientX: endX,
        clientY: endY
      });

      // Dispatch touch sequence
      gameContainer.dispatchEvent(new TouchEvent('touchstart', {
        touches: [touchStart],
        targetTouches: [touchStart],
        changedTouches: [touchStart],
        bubbles: true
      }));

      gameContainer.dispatchEvent(new TouchEvent('touchmove', {
        touches: [touchEnd],
        targetTouches: [touchEnd],
        changedTouches: [touchEnd],
        bubbles: true
      }));

      gameContainer.dispatchEvent(new Touctouchend', {
        touches: [],
        targetTouches: [],
        changedTouches: [touchEnd],
        bubbles: true
      }));

    } catch (error) {
      console.warn('Touch simulation failed:', error);
    }
  }

  getGameInfo() {
    const scoreElement = document.querySelector('.score-container');
    const gameOverElement = document.querySelector('.game-over');
    const gameWonElement = document.querySelector('.game-won');

    return {
      score: scoreElement ? parseInt(scoreElement.textContent, 10) || 0 : 0,
      gameOver: !!gameOverElement,
      won: !!gameWonElement
    };
  }
}
```

### Generic Numeric Grid Adapter

```javascript
class GenericGridAdapter {
  canAttach() {
    const candidates = this.findNumericCandidates();
    return candidates.length >= 8; // Minimum tiles for detection
  }

  findNumericCandidates() {
    // Look for elements containing 2048-style numbers
    const validNumbers =
      /^(2|4|8|16|32|64|128|256|512|1024|2048|4096|8192|16384)$/;

    return Array.from(document.querySelectorAll("div, span, p, td, th"))
      .filter((el) => {
        // Must be visible
        if (!el.offsetParent) return false;

        // Must contain valid 2048 number
        const text = el.textContent.trim();
        return validNumbers.test(text);
      })
      .map((el) => ({
        element: el,
        value: parseInt(el.textContent.trim(), 10),
        rect: el.getBoundingClientRect(),
      }));
  }

  readBoard() {
    const candidates = this.findNumericCandidates();
    if (candidates.length < 4) return null;

    // Group by position to form grid
    const grid = this.arrangeIntoGrid(candidates);
    return grid;
  }

  arrangeIntoGrid(candidates) {
    // Extract unique X and Y positions
    const xPositions = [
      ...new Set(candidates.map((c) => Math.round(c.rect.left))),
    ].sort((a, b) => a - b);
    const yPositions = [
      ...new Set(candidates.map((c) => Math.round(c.rect.top))),
    ].sort((a, b) => a - b);

    // Cluster nearby positions (handle slight variations)
    const clusterPositions = (positions, threshold = 30) => {
      const clusters = [];

      for (const pos of positions) {
        let added = false;

        for (const cluster of clusters) {
          if (Math.abs(cluster.avg - pos) <= threshold) {
            cluster.positions.push(pos);
            cluster.sum += pos;
            cluster.avg = cluster.sum / cluster.positions.length;
            added = true;
            break;
          }
        }

        if (!added) {
          clusters.push({
            positions: [pos],
            sum: pos,
            avg: pos,
          });
        }
      }

      return clusters.map((c) => Math.round(c.avg)).slice(0, 4);
    };

    const cols = clusterPositions(xPositions);
    const rows = clusterPositions(yPositions);

    if (cols.length < 4 || rows.length < 4) return null;

    // Create 4x4 grid
    const grid = Array.from({ length: 4 }, () => Array(4).fill(0));

    // Place candidates in grid
    candidates.forEach((candidate) => {
      const x = Math.round(candidate.rect.left);
      const y = Math.round(candidate.rect.top);

      // Find closest grid position
      const colIndex = this.findClosestIndex(cols, x);
      const rowIndex = this.findClosestIndex(rows, y);

      if (colIndex >= 0 && rowIndex >= 0) {
        // Keep highest value if multiple tiles in same position
        grid[rowIndex][colIndex] = Math.max(
          grid[rowIndex][colIndex],
          candidate.value
        );
      }
    });

    return grid;
  }

  findClosestIndex(positions, target) {
    let closestIndex = -1;
    let minDistance = Infinity;

    positions.forEach((pos, index) => {
      const distance = Math.abs(pos - target);
      if (distance < minDistance && distance <= 30) {
        minDistance = distance;
        closestIndex = index;
      }
    });

    return closestIndex;
  }

  sendMove(direction) {
    // Generic approach: try multiple input methods
    this.sendKeyboardInput(direction);
    this.sendSwipeInput(direction);
    this.sendClickInput(direction);
  }

  sendKeyboardInput(direction) {
    const keys = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
    const keyCodes = [38, 39, 40, 37];

    const event = new KeyboardEvent("keydown", {
      key: keys[direction],
      keyCode: keyCodes[direction],
      which: keyCodes[direction],
      bubbles: true,
    });

    // Try multiple targets
    const targets = [
      document.activeElement,
      document.querySelector("[tabindex]"),
      document.querySelector("canvas"),
      document.body,
    ].filter(Boolean);

    targets.forEach((target) => target.dispatchEvent(event));
  }

  sendSwipeInput(direction) {
    // Similar to Play2048Adapter but on document center
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    const deltas = [
      { x: 0, y: -120 }, // Up
      { x: 120, y: 0 }, // Right
      { x: 0, y: 120 }, // Down
      { x: -120, y: 0 }, // Left
    ];

    const delta = deltas[direction];

    try {
      const target =
        document.elementFromPoint(centerX, centerY) || document.body;

      const touchStart = new Touch({
        identifier: 1,
        target,
        clientX: centerX,
        clientY: centerY,
      });

      const touchEnd = new Touch({
        identifier: 1,
        target,
        clientX: centerX + delta.x,
        clientY: centerY + delta.y,
      });

      target.dispatchEvent(
        new TouchEvent("touchstart", {
          touches: [touchStart],
          changedTouches: [touchStart],
          bubbles: true,
        })
      );

      target.dispatchEvent(
        new TouchEvent("touchmove", {
          touches: [touchEnd],
          changedTouches: [touchEnd],
          bubbles: true,
        })
      );

      target.dispatchEvent(
        new TouchEvent("touchend", {
          touches: [],
          changedTouches: [touchEnd],
          bubbles: true,
        })
      );
    } catch (error) {
      console.warn("Generic swipe failed:", error);
    }
  }

  sendClickInput(direction) {
    // Look for directional buttons
    const buttonSelectors = [
      "button[data-direction]",
      ".direction-button",
      ".arrow-button",
      '[class*="arrow"]',
      '[class*="direction"]',
    ];

    const directionNames = ["up", "right", "down", "left"];
    const targetDirection = directionNames[direction];

    for (const selector of buttonSelectors) {
      const buttons = document.querySelectorAll(selector);

      for (const button of buttons) {
        const buttonText = button.textContent.toLowerCase();
        const buttonClass = button.className.toLowerCase();
        const buttonData = button.dataset.direction?.toLowerCase();

        if (
          buttonText.includes(targetDirection) ||
          buttonClass.includes(targetDirection) ||
          buttonData === targetDirection
        ) {
          button.click();
          return;
        }
      }
    }
  }
}
```

## DOM Change Detection

### Board State Monitoring

```javascript
class BoardMonitor {
  constructor(adapter) {
    this.adapter = adapter;
    this.lastBoardHash = null;
    this.observer = null;
    this.changeCallbacks = [];
  }

  start() {
    this.updateHash();
    this.setupMutationObserver();
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  setupMutationObserver() {
    // Watch for changes in tile containers
    const containers = [
      document.querySelector(".tile-container"),
      document.querySelector(".game-container"),
      document.querySelector('[class*="grid"]'),
      document.querySelector('[class*="board"]'),
    ].filter(Boolean);

    if (containers.length === 0) {
      // Fallback: watch entire document
      containers.push(document.body);
    }

    this.observer = new MutationObserver((mutations) => {
      let hasRelevantChange = false;

      mutations.forEach((mutation) => {
        // Check if changes affect game tiles
        if (mutation.type === "childList") {
          const addedNodes = Array.from(mutation.addedNodes);
          const removedNodes = Array.from(mutation.removedNodes);

          const isGameRelated = (node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const className = node.className || "";
            return (
              className.includes("tile") ||
              className.includes("cell") ||
              className.includes("grid")
            );
          };

          if (
            addedNodes.some(isGameRelated) ||
            removedNodes.some(isGameRelated)
          ) {
            hasRelevantChange = true;
          }
        }

        if (mutation.type === "attributes") {
          const target = mutation.target;
          const className = target.className || "";

          if (className.includes("tile") || className.includes("position")) {
            hasRelevantChange = true;
          }
        }
      });

      if (hasRelevantChange) {
        this.checkForChanges();
      }
    });

    containers.forEach((container) => {
      this.observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    });
  }

  checkForChanges() {
    const currentHash = this.getBoardHash();

    if (currentHash !== this.lastBoardHash) {
      this.lastBoardHash = currentHash;
      this.notifyChange();
    }
  }

  getBoardHash() {
    const board = this.adapter.readBoard();
    return board ? board.flat().join(",") : "";
  }

  updateHash() {
    this.lastBoardHash = this.getBoardHash();
  }

  hasChanged() {
    const currentHash = this.getBoardHash();
    return currentHash !== this.lastBoardHash;
  }

  onBoardChange(callback) {
    this.changeCallbacks.push(callback);
  }

  notifyChange() {
    this.changeCallbacks.forEach((callback) => {
      try {
        callback();
      } catch (error) {
        console.error("Board change callback failed:", error);
      }
    });
  }
}
```

### Move Verification

```javascript
class MoveVerifier {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async verifyMove(direction, timeoutMs = 1000) {
    const beforeBoard = this.adapter.readBoard();
    const beforeHash = this.hashBoard(beforeBoard);

    // Execute move
    this.adapter.sendMove(direction);

    // Wait for change with timeout
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await this.sleep(50);

      const afterBoard = this.adapter.readBoard();
      const afterHash = this.hashBoard(afterBoard);

      if (afterHash !== beforeHash) {
        return {
          success: true,
          changed: true,
          beforeBoard,
          afterBoard,
          timeTaken: Date.now() - startTime,
        };
      }
    }

    // No change detected
    return {
      success: false,
      changed: false,
      beforeBoard,
      afterBoard: this.adapter.readBoard(),
      timeTaken: Date.now() - startTime,
    };
  }

  hashBoard(board) {
    return board ? board.flat().join(",") : "";
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isValidMove(board, direction) {
    // Simulate move to check if it would change the board
    const simulated = this.simulateMove(board, direction);
    return JSON.stringify(board) !== JSON.stringify(simulated);
  }

  simulateMove(board, direction) {
    if (!board) return null;

    const newBoard = board.map((row) => [...row]);

    switch (direction) {
      case 0: // Up
        for (let col = 0; col < 4; col++) {
          const column = [
            newBoard[0][col],
            newBoard[1][col],
            newBoard[2][col],
            newBoard[3][col],
          ];
          const shifted = this.shiftLine(column);
          for (let row = 0; row < 4; row++) {
            newBoard[row][col] = shifted[row];
          }
        }
        break;

      case 1: // Right
        for (let row = 0; row < 4; row++) {
          newBoard[row] = this.shiftLine(newBoard[row].reverse()).reverse();
        }
        break;

      case 2: // Down
        for (let col = 0; col < 4; col++) {
          const column = [
            newBoard[3][col],
            newBoard[2][col],
            newBoard[1][col],
            newBoard[0][col],
          ];
          const shifted = this.shiftLine(column);
          for (let row = 0; row < 4; row++) {
            newBoard[3 - row][col] = shifted[row];
          }
        }
        break;

      case 3: // Left
        for (let row = 0; row < 4; row++) {
          newBoard[row] = this.shiftLine(newBoard[row]);
        }
        break;
    }

    return newBoard;
  }

  shiftLine(line) {
    // Remove zeros
    const nonZero = line.filter((x) => x !== 0);
    const result = [];

    // Merge adjacent equal values
    for (let i = 0; i < nonZero.length; i++) {
      if (i < nonZero.length - 1 && nonZero[i] === nonZero[i + 1]) {
        result.push(nonZero[i] * 2);
        i++; // Skip next element
      } else {
        result.push(nonZero[i]);
      }
    }

    // Pad with zeros
    while (result.length < 4) {
      result.push(0);
    }

    return result;
  }
}
```

## Error Recovery Patterns

### Adapter Reattachment

```javascript
class AdapterManager {
  constructor() {
    this.registry = new AdapterRegistry();
    this.currentAdapter = null;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async detectWithRetry() {
    this.retryCount = 0;

    while (this.retryCount < this.maxRetries) {
      try {
        const adapter = this.registry.detect();

        if (adapter) {
          this.currentAdapter = adapter;
          this.retryCount = 0;
          return adapter;
        }

        // Wait before retry
        await this.sleep(1000 * (this.retryCount + 1));
        this.retryCount++;
      } catch (error) {
        console.error(
          `Detection attempt ${this.retryCount + 1} failed:`,
          error
        );
        this.retryCount++;

        if (this.retryCount >= this.maxRetries) {
          throw new Error("All detection attempts failed");
        }

        await this.sleep(2000);
      }
    }

    throw new Error("No adapter found after retries");
  }

  async reattachOnError() {
    console.log("Attempting adapter reattachment...");

    try {
      const newAdapter = await this.detectWithRetry();

      if (newAdapter) {
        console.log("Adapter reattached successfully");
        return newAdapter;
      }
    } catch (error) {
      console.error("Reattachment failed:", error);
    }

    return null;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### Graceful Degradation

```javascript
class RobustGameController {
  constructor() {
    this.adapterManager = new AdapterManager();
    this.fallbackMode = false;
    this.errorCount = 0;
    this.maxErrors = 5;
  }

  async executeMove(direction) {
    try {
      const adapter = this.adapterManager.currentAdapter;

      if (!adapter) {
        await this.adapterManager.detectWithRetry();
      }

      const verifier = new MoveVerifier(adapter);
      const result = await verifier.verifyMove(direction);

      if (result.success) {
        this.errorCount = 0; // Reset error count on success
        return result;
      } else {
        throw new Error("Move verification failed");
      }
    } catch (error) {
      this.errorCount++;
      console.error(
        `Move execution error (${this.errorCount}/${this.maxErrors}):`,
        error
      );

      if (this.errorCount >= this.maxErrors) {
        console.log("Entering fallback mode");
        this.fallbackMode = true;
        return this.executeFallbackMove(direction);
      }

      // Try to recover
      await this.adapterManager.reattachOnError();
      throw error;
    }
  }

  executeFallbackMove(direction) {
    // Simple fallback: just send keyboard events
    const keys = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
    const event = new KeyboardEvent("keydown", {
      key: keys[direction],
      bubbles: true,
    });

    document.body.dispatchEvent(event);

    return {
      success: true,
      fallback: true,
      direction,
    };
  }
}
```
