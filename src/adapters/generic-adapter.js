/**
 * @fileoverview Generic adapter for 4x4 numeric grid games
 * Uses heuristic detection to find game boards in various implementations
 */

import { Adapter, Direction, BoardUtils } from "./adapter.js";

/**
 * Generic adapter that attempts to detect 4x4 grids using heuristics
 * Fallback for sites that don't match specific adapter patterns
 */
export class GenericAdapter extends Adapter {
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

    // Cache detected elements to avoid re-scanning
    this._cachedGameContainer = null;
    this._cachedBoardElements = null;
    this._lastScanTime = 0;
    this._scanCacheMs = 1000; // Cache for 1 second
  }

  /**
   * Check if this adapter can detect a 4x4 grid on the page
   * Uses heuristic detection for various game implementations
   */
  canAttach() {
    const detection = this._detectGameBoard();
    return detection.found;
  }

  /**
   * Extract game state using heuristic grid detection
   * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
   */
  readBoard() {
    try {
      const detection = this._detectGameBoard();
      if (!detection.found || !detection.elements) {
        return null;
      }

      const board = BoardUtils.createEmptyBoard();
      const elements = detection.elements;

      // Try to extract values from detected grid elements
      for (let i = 0; i < Math.min(elements.length, 16); i++) {
        const row = Math.floor(i / 4);
        const col = i % 4;
        const element = elements[i];

        if (element) {
          const value = this._extractValueFromElement(element);
          board[row][col] = value;
        }
      }

      return board;
    } catch (error) {
      console.warn("GenericAdapter: Failed to read board:", error);
      return null;
    }
  }

  /**
   * Send move command via keyboard events
   * @param {0|1|2|3} dir Direction to move
   */
  sendMove(dir) {
    try {
      // Try keyboard events on various targets
      this._dispatchKeyboardEvent(dir);

      // Also try touch simulation as fallback
      setTimeout(() => {
        this._simulateTouch(dir);
      }, 10);
    } catch (error) {
      console.warn("GenericAdapter: Failed to send move:", error);
    }
  }

  /**
   * Attempt to get score from common score element patterns
   * @returns {number|null} Current score or null if not found
   */
  getScore() {
    try {
      // Common score selectors
      const scoreSelectors = [
        ".score",
        "#score",
        '[class*="score"]',
        '[id*="score"]',
        ".current-score",
        ".game-score",
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
   * Detect game board using heuristic analysis
   * @private
   * @returns {{found: boolean, elements: Element[]|null, container: Element|null}}
   */
  _detectGameBoard() {
    const now = Date.now();

    // Return cached result if recent
    if (
      this._cachedBoardElements &&
      now - this._lastScanTime < this._scanCacheMs
    ) {
      return {
        found: true,
        elements: this._cachedBoardElements,
        container: this._cachedGameContainer,
      };
    }

    // Look for 4x4 grid patterns
    const candidates = this._findGridCandidates();

    for (const candidate of candidates) {
      const elements = this._extractGridElements(candidate);
      if (elements && elements.length === 16) {
        // Validate that elements contain numeric content
        const numericElements = elements.filter((el) =>
          this._hasNumericContent(el)
        );

        // Accept if at least 2 elements have numeric content (game in progress)
        if (numericElements.length >= 2) {
          this._cachedGameContainer = candidate;
          this._cachedBoardElements = elements;
          this._lastScanTime = now;

          return {
            found: true,
            elements: elements,
            container: candidate,
          };
        }
      }
    }

    return { found: false, elements: null, container: null };
  }

  /**
   * Find potential game container elements
   * @private
   * @returns {Element[]} Array of candidate elements
   */
  _findGridCandidates() {
    const candidates = [];

    // Look for common game container patterns
    const containerSelectors = [
      '[class*="game"]',
      '[class*="board"]',
      '[class*="grid"]',
      '[id*="game"]',
      '[id*="board"]',
      '[id*="grid"]',
      "canvas", // Some games use canvas
      ".container",
    ];

    for (const selector of containerSelectors) {
      const elements = document.querySelectorAll(selector);
      candidates.push(...Array.from(elements));
    }

    // Also check for elements with 16 child elements (potential 4x4 grid)
    const allElements = document.querySelectorAll("*");
    for (const element of allElements) {
      if (element.children.length === 16) {
        candidates.push(element);
      }
    }

    // Remove duplicates and sort by likelihood
    const uniqueCandidates = [...new Set(candidates)];
    return uniqueCandidates.sort(
      (a, b) => this._scoreCandidate(b) - this._scoreCandidate(a)
    );
  }

  /**
   * Score candidate element based on likelihood of being a game board
   * @private
   * @param {Element} element Element to score
   * @returns {number} Score (higher is better)
   */
  _scoreCandidate(element) {
    let score = 0;

    const className = element.className.toLowerCase();
    const id = element.id.toLowerCase();

    // Boost score for game-related terms
    if (className.includes("game") || id.includes("game")) score += 10;
    if (className.includes("board") || id.includes("board")) score += 8;
    if (className.includes("grid") || id.includes("grid")) score += 6;
    if (className.includes("2048")) score += 15;

    // Boost for having 16 children (4x4 grid)
    if (element.children.length === 16) score += 20;

    // Boost for square-ish dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const aspectRatio = rect.width / rect.height;
      if (aspectRatio >= 0.8 && aspectRatio <= 1.2) score += 5;
    }

    return score;
  }

  /**
   * Extract grid elements from container
   * @private
   * @param {Element} container Container element
   * @returns {Element[]|null} Array of 16 elements or null
   */
  _extractGridElements(container) {
    // If container has exactly 16 children, use them
    if (container.children.length === 16) {
      return Array.from(container.children);
    }

    // Look for nested grid structures
    const gridElements = [];

    // Try to find 4 rows with 4 elements each
    const rows = Array.from(container.children);
    if (rows.length === 4) {
      for (const row of rows) {
        if (row.children.length === 4) {
          gridElements.push(...Array.from(row.children));
        } else {
          return null; // Not a valid 4x4 structure
        }
      }

      if (gridElements.length === 16) {
        return gridElements;
      }
    }

    return null;
  }

  /**
   * Check if element has numeric content
   * @private
   * @param {Element} element Element to check
   * @returns {boolean} True if element contains numbers
   */
  _hasNumericContent(element) {
    const text = (element.textContent || element.innerText || "").trim();
    return /\d+/.test(text);
  }

  /**
   * Extract numeric value from element
   * @private
   * @param {Element} element Element to extract from
   * @returns {number} Extracted value or 0
   */
  _extractValueFromElement(element) {
    const text = (element.textContent || element.innerText || "").trim();
    return BoardUtils.parseTileValue(text);
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

    // Try multiple targets
    const targets = [
      document.activeElement,
      this._cachedGameContainer,
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

      target.dispatchEvent(keydownEvent);
    }
  }

  /**
   * Simulate touch swipe gesture
   * @private
   * @param {number} dir Direction
   */
  _simulateTouch(dir) {
    try {
      const container = this._cachedGameContainer || document.body;
      const rect = container.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      let startX = centerX,
        startY = centerY;
      let endX = centerX,
        endY = centerY;

      const swipeDistance = Math.min(rect.width, rect.height) * 0.3;

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

      // Create and dispatch touch events
      const touchStart = new TouchEvent("touchstart", {
        touches: [
          new Touch({
            identifier: 0,
            target: container,
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
            target: container,
            clientX: endX,
            clientY: endY,
          }),
        ],
        bubbles: true,
        cancelable: true,
      });

      container.dispatchEvent(touchStart);
      setTimeout(() => container.dispatchEvent(touchEnd), 50);
    } catch (error) {
      // Touch events might not be supported, ignore silently
    }
  }
}
