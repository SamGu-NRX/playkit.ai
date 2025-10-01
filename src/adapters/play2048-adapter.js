/**
 * @fileoverview Adapter for play2048.co and similar implementations
 * Handles DOM selectors for tiles, score, and move execution
 */

import { Adapter, Direction, BoardUtils } from "./adapter.js";

/**
 * Adapter for play2048.co style games
 * Detects games with .tile-container and .tile elements
 */
export class Play2048Adapter extends Adapter {
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
   * Check if this adapter can attach to the current page
   * Looks for play2048.co style DOM structure
   */
  canAttach() {
    // Look for tile container and at least one tile
    const tileContainer = document.querySelector(".tile-container");
    const tiles = document.querySelectorAll(".tile");

    // Also check for game container as additional validation
    const gameContainer = document.querySelector(".game-container");

    return !!(tileContainer && tiles.length > 0 && gameContainer);
  }

  /**
   * Extract current game state from DOM
   * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
   */
  readBoard() {
    try {
      const board = BoardUtils.createEmptyBoard();

      // Get all tiles with position classes
      const tiles = document.querySelectorAll(".tile");

      for (const tile of tiles) {
        const position = this._extractTilePosition(tile);
        const value = this._extractTileValue(tile);

        if (position && value > 0) {
          const { row, col } = position;
          if (row >= 0 && row < 4 && col >= 0 && col < 4) {
            // Use the highest value if multiple tiles occupy same position
            board[row][col] = Math.max(board[row][col], value);
          }
        }
      }

      return board;
    } catch (error) {
      console.warn("Play2048Adapter: Failed to read board:", error);
      return null;
    }
  }

  /**
   * Send move command via keyboard events
   * @param {0|1|2|3} dir Direction to move
   */
  sendMove(dir) {
    try {
      // First try keyboard event
      this._dispatchKeyboardEvent(dir);

      // Small delay then try touch simulation as fallback
      setTimeout(() => {
        this._simulateTouch(dir);
      }, 10);
    } catch (error) {
      console.warn("Play2048Adapter: Failed to send move:", error);
    }
  }

  /**
   * Get current score from DOM
   * @returns {number|null} Current score or null if not found
   */
  getScore() {
    try {
      const selectors = [
        ".score-container .score",
        ".score-container",
        ".current-score",
        "#score",
      ];

      for (const selector of selectors) {
        const scoreElement = document.querySelector(selector);
        if (scoreElement) {
          // Ignore best score containers
          if (scoreElement.classList?.contains("best-container")) {
            continue;
          }

          const scoreText = (scoreElement.textContent || "").trim();
          if (!scoreText) continue;

          const sanitized = scoreText.replace(/[^\d]/g, "");
          if (!sanitized) continue;

          const score = parseInt(sanitized, 10);
          if (!Number.isNaN(score)) {
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
   * Check if game is over by looking for game-over overlay
   * @returns {boolean} True if game over
   */
  isGameOver() {
    const gameOverElement = document.querySelector(".game-over");
    const gameWonElement = document.querySelector(".game-won");
    return !!(gameOverElement || gameWonElement);
  }

  /**
   * Extract tile position from CSS classes
   * @private
   * @param {Element} tile Tile element
   * @returns {{row: number, col: number}|null} Position or null
   */
  _extractTilePosition(tile) {
    try {
      // Look for position classes like "tile-position-1-2"
      const classes = Array.from(tile.classList);
      const positionClass = classes.find((cls) =>
        cls.startsWith("tile-position-")
      );

      if (positionClass) {
        const match = positionClass.match(/tile-position-(\d+)-(\d+)/);
        if (match) {
          // Convert from 1-based to 0-based indexing
          const col = parseInt(match[1], 10) - 1;
          const row = parseInt(match[2], 10) - 1;
          return { row, col };
        }
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
      // Look for tile-X class or text content
      const classes = Array.from(tile.classList);
      const valueClass = classes.find(
        (cls) =>
          cls.startsWith("tile-") &&
          cls !== "tile-container" &&
          !cls.startsWith("tile-position-")
      );

      if (valueClass) {
        const match = valueClass.match(/tile-(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }

      // Fallback to text content
      const text = tile.textContent || tile.innerText;
      return BoardUtils.parseTileValue(text);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Dispatch keyboard event for move
   * @private
   * @param {number} dir Direction
   */
  _dispatchKeyboardEvent(dir) {
    const key = this.keyMap[dir];
    const keyCode = this.keyCodeMap[dir];

    if (!key) return;

    const target = document.activeElement || document.body;

    // Dispatch keydown event
    const keydownEvent = new KeyboardEvent("keydown", {
      key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    });

    target.dispatchEvent(keydownEvent);

    // Also dispatch keyup for completeness
    const keyupEvent = new KeyboardEvent("keyup", {
      key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    });

    target.dispatchEvent(keyupEvent);
  }

  /**
   * Simulate touch swipe gesture
   * @private
   * @param {number} dir Direction
   */
  _simulateTouch(dir) {
    try {
      const gameContainer =
        document.querySelector(".game-container") || document.body;
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

      // Create touch events
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
      // Touch events might not be supported, ignore silently
    }
  }
}
