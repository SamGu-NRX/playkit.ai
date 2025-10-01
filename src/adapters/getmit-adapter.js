/**
 * @fileoverview Specific adapter for https://mitchgu.github.io/GetMIT/
 * Handles the unique DOM structure and interaction patterns of this site
 */

import { Adapter, Direction, BoardUtils } from "./adapter.js";

/**
 * Adapter specifically for the GetMIT 2048 game
 * Handles site-specific DOM patterns and input methods
 */
export class GetMITAdapter extends Adapter {
  constructor() {
    super();
    this.keyMap = {
      [Direction.UP]: "ArrowUp",
      [Direction.RIGHT]: "ArrowRight",
      [Direction.DOWN]: "ArrowDown",
      [Direction.LEFT]: "ArrowLeft",
    };
    this.keyCodeMap = {
      [Direction.UP]: 38,
      [Direction.RIGHT]: 39,
      [Direction.DOWN]: 40,
      [Direction.LEFT]: 37,
    };
  }

  /**
   * Check if this adapter can attach to the GetMIT page
   */
  canAttach() {
    // Check for GetMIT specific indicators
    const isGetMITSite =
      window.location.hostname.includes("mitchgu.github.io") &&
      window.location.pathname.includes("GetMIT");

    if (!isGetMITSite) return false;

    // Look for game-specific elements
    const gameContainer =
      document.querySelector("#game-container") ||
      document.querySelector(".game-container") ||
      document.querySelector('[class*="game"]');

    const tiles =
      document.querySelectorAll('[class*="tile"]') ||
      document.querySelectorAll('[class*="cell"]') ||
      document.querySelectorAll(".grid-cell");

    return !!(gameContainer && tiles.length > 0);
  }

  /**
   * Extract current game state from GetMIT DOM structure
   * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
   */
  readBoard() {
    try {
      const board = BoardUtils.createEmptyBoard();

      // Try multiple selector patterns that might be used
      const tileSelectors = [
        ".tile",
        '[class*="tile"]',
        ".grid-cell",
        '[class*="cell"]',
        ".game-cell",
      ];

      let tiles = null;
      for (const selector of tileSelectors) {
        tiles = document.querySelectorAll(selector);
        if (tiles.length > 0) break;
      }

      if (!tiles || tiles.length === 0) {
        // Fallback: look for any elements with numeric content in a grid-like structure
        return this._extractFromGenericGrid();
      }

      // If we have exactly 16 tiles, assume they're in row-major order
      if (tiles.length === 16) {
        for (let i = 0; i < 16; i++) {
          const row = Math.floor(i / 4);
          const col = i % 4;
          const value = this._extractTileValue(tiles[i]);
          board[row][col] = value;
        }
        return board;
      }

      // Otherwise, try to extract position information
      for (const tile of tiles) {
        const position = this._extractTilePosition(tile);
        const value = this._extractTileValue(tile);

        if (position && value > 0) {
          const { row, col } = position;
          if (row >= 0 && row < 4 && col >= 0 && col < 4) {
            board[row][col] = Math.max(board[row][col], value);
          }
        }
      }

      return board;
    } catch (error) {
      console.warn("GetMITAdapter: Failed to read board:", error);
      return null;
    }
  }

  /**
   * Send move command to GetMIT game
   * @param {0|1|2|3} dir Direction to move
   */
  sendMove(dir) {
    try {
      // Try keyboard events first
      this._dispatchKeyboardEvent(dir);

      // Also try touch simulation
      setTimeout(() => {
        this._simulateTouch(dir);
      }, 10);

      // Some games might use custom event handlers
      setTimeout(() => {
        this._tryCustomEvents(dir);
      }, 20);
    } catch (error) {
      console.warn("GetMITAdapter: Failed to send move:", error);
    }
  }

  /**
   * Get current score from GetMIT game
   * @returns {number|null} Current score or null if not found
   */
  getScore() {
    try {
      // Try common score element patterns
      const scoreSelectors = [
        ".score",
        "#score",
        ".current-score",
        '[class*="score"]',
        ".score-container .score",
      ];

      for (const selector of scoreSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const text = element.textContent || element.innerText;
          const score = parseInt(text.replace(/[^\d]/g, ""), 10);
          if (!isNaN(score)) {
            return score;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if GetMIT game is over
   * @returns {boolean} True if game over
   */
  isGameOver() {
    // Look for game over indicators
    const gameOverSelectors = [
      ".game-over",
      ".game-won",
      '[class*="game-over"]',
      '[class*="game-won"]',
      ".overlay",
    ];

    for (const selector of gameOverSelectors) {
      const element = document.querySelector(selector);
      if (element && element.style.display !== "none") {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract tile position from element
   * @private
   * @param {Element} tile Tile element
   * @returns {{row: number, col: number}|null} Position or null
   */
  _extractTilePosition(tile) {
    try {
      // Look for position classes or data attributes
      const classes = Array.from(tile.classList);

      // Try various position class patterns
      const patterns = [
        /tile-position-(\d+)-(\d+)/,
        /pos-(\d+)-(\d+)/,
        /cell-(\d+)-(\d+)/,
        /r(\d+)c(\d+)/,
      ];

      for (const pattern of patterns) {
        for (const className of classes) {
          const match = className.match(pattern);
          if (match) {
            const col = parseInt(match[1], 10) - 1; // Convert to 0-based
            const row = parseInt(match[2], 10) - 1;
            return { row, col };
          }
        }
      }

      // Try data attributes
      const dataRow = tile.dataset.row || tile.dataset.y;
      const dataCol = tile.dataset.col || tile.dataset.column || tile.dataset.x;

      if (dataRow !== undefined && dataCol !== undefined) {
        return {
          row: parseInt(dataRow, 10),
          col: parseInt(dataCol, 10),
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract tile value from element
   * @private
   * @param {Element} tile Tile element
   * @returns {number} Tile value or 0
   */
  _extractTileValue(tile) {
    try {
      // Look for value in class names first
      const classes = Array.from(tile.classList);
      const valueClass = classes.find(
        (cls) => /tile-(\d+)/.test(cls) || /value-(\d+)/.test(cls)
      );

      if (valueClass) {
        const match = valueClass.match(/(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }

      // Try data attributes
      if (tile.dataset.value) {
        return parseInt(tile.dataset.value, 10) || 0;
      }

      // Fallback to text content
      const text = tile.textContent || tile.innerText;
      return BoardUtils.parseTileValue(text);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Extract board from generic grid structure
   * @private
   * @returns {number[][]|null} Board matrix or null
   */
  _extractFromGenericGrid() {
    try {
      const board = BoardUtils.createEmptyBoard();

      // Look for container with 16 children
      const containers = document.querySelectorAll("*");
      for (const container of containers) {
        if (container.children.length === 16) {
          for (let i = 0; i < 16; i++) {
            const row = Math.floor(i / 4);
            const col = i % 4;
            const value = this._extractTileValue(container.children[i]);
            board[row][col] = value;
          }
          return board;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Dispatch keyboard event
   * @private
   * @param {number} dir Direction
   */
  _dispatchKeyboardEvent(dir) {
    const key = this.keyMap[dir];
    const keyCode = this.keyCodeMap[dir];

    if (!key) return;

    // Try multiple targets
    const targets = [
      document.activeElement,
      document.querySelector("#game-container"),
      document.querySelector(".game-container"),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const target of targets) {
      const keydownEvent = new KeyboardEvent("keydown", {
        key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });

      const keyupEvent = new KeyboardEvent("keyup", {
        key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });

      target.dispatchEvent(keydownEvent);
      target.dispatchEvent(keyupEvent);
    }
  }

  /**
   * Simulate touch swipe
   * @private
   * @param {number} dir Direction
   */
  _simulateTouch(dir) {
    try {
      const gameContainer =
        document.querySelector("#game-container") ||
        document.querySelector(".game-container") ||
        document.body;

      const rect = gameContainer.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      let startX = centerX,
        startY = centerY;
      let endX = centerX,
        endY = centerY;

      const swipeDistance = 100;

      switch (dir) {
        case Direction.UP:
          startY += swipeDistance / 2;
          endY -= swipeDistance / 2;
          break;
        case Direction.DOWN:
          startY -= swipeDistance / 2;
          endY += swipeDistance / 2;
          break;
        case Direction.LEFT:
          startX += swipeDistance / 2;
          endX -= swipeDistance / 2;
          break;
        case Direction.RIGHT:
          startX -= swipeDistance / 2;
          endX += swipeDistance / 2;
          break;
      }

      const touchStart = new TouchEvent("touchstart", {
        touches: [
          new Touch({
            identifier: 0,
            target: gameContainer,
            clientX: startX,
            clientY: startY,
          }),
        ],
        bubbles: true,
        cancelable: true,
      });

      const touchEnd = new TouchEvent("touchend", {
        changedTouches: [
          new Touch({
            identifier: 0,
            target: gameContainer,
            clientX: endX,
            clientY: endY,
          }),
        ],
        bubbles: true,
        cancelable: true,
      });

      gameContainer.dispatchEvent(touchStart);
      setTimeout(() => gameContainer.dispatchEvent(touchEnd), 50);
    } catch (error) {
      // Touch events might not be supported
    }
  }

  /**
   * Try custom event patterns that might be used by the game
   * @private
   * @param {number} dir Direction
   */
  _tryCustomEvents(dir) {
    try {
      const directionNames = ["up", "right", "down", "left"];
      const directionName = directionNames[dir];

      // Try custom events
      const customEvent = new CustomEvent("move", {
        detail: { direction: directionName },
        bubbles: true,
      });

      const gameContainer =
        document.querySelector("#game-container") ||
        document.querySelector(".game-container") ||
        document.body;

      gameContainer.dispatchEvent(customEvent);
    } catch (error) {
      // Custom events might not be supported
    }
  }
}
