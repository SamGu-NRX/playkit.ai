/**
 * @fileoverview MutationObserver for change detection and game monitoring
 * Provides efficient DOM change detection for game state monitoring
 */

import { BoardUtils } from "../adapters/index.js";

/**
 * Enhanced MutationObserver for game state monitoring
 * Watches for DOM changes that indicate game moves or state changes
 */
export class GameMutationObserver {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.observer = null;
    this.isObserving = false;

    // Configuration
    this.config = {
      debounceMs: options.debounceMs || 50,
      maxCallbacksPerSecond: options.maxCallbacksPerSecond || 20,
      watchAttributes: options.watchAttributes !== false,
      watchChildList: options.watchChildList !== false,
      watchSubtree: options.watchSubtree !== false,
    };

    // State tracking
    this.lastBoardHash = "";
    this.lastChangeTime = 0;
    this.changeCount = 0;
    this.debounceTimer = null;

    // Callbacks
    this.onBoardChange = null;
    this.onGameStateChange = null;
    this.onError = null;

    // Bind methods
    this.handleMutations = this.handleMutations.bind(this);
    this.debouncedCheck = this.debouncedCheck.bind(this);
  }

  /**
   * Start observing DOM changes
   * @param {Element} [targetElement] Specific element to observe, or auto-detect
   */
  startObserving(targetElement = null) {
    if (this.isObserving) {
      console.warn("GameMutationObserver already observing");
      return;
    }

    if (!this.adapter) {
      throw new Error("No adapter set");
    }

    // Determine target element
    const target = targetElement || this.findGameContainer();
    if (!target) {
      console.warn("Could not find game container to observe");
      return;
    }

    // Create observer
    this.observer = new MutationObserver(this.handleMutations);

    // Configure observation options
    const observerConfig = {
      childList: this.config.watchChildList,
      attributes: this.config.watchAttributes,
      subtree: this.config.watchSubtree,
      attributeOldValue: false,
      characterData: true,
      characterDataOldValue: false,
    };

    // Start observing
    this.observer.observe(target, observerConfig);
    this.isObserving = true;

    // Initialize baseline
    this.updateBaseline();

    console.log(
      `GameMutationObserver started on ${target.tagName}${
        target.className ? "." + target.className : ""
      }`
    );
  }

  /**
   * Stop observing DOM changes
   */
  stopObserving() {
    if (!this.isObserving) return;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.isObserving = false;
    console.log("GameMutationObserver stopped");
  }

  /**
   * Handle mutation events
   * @private
   * @param {MutationRecord[]} mutations Array of mutation records
   */
  handleMutations(mutations) {
    if (!this.isObserving) return;

    // Rate limiting
    const now = Date.now();
    if (now - this.lastChangeTime < 1000 / this.config.maxCallbacksPerSecond) {
      return;
    }

    // Check if mutations are relevant to game state
    const relevantMutations = mutations.filter((mutation) =>
      this.isRelevantMutation(mutation)
    );

    if (relevantMutations.length === 0) return;

    // Debounce the actual check
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(
      this.debouncedCheck,
      this.config.debounceMs
    );
  }

  /**
   * Check if a mutation is relevant to game state
   * @private
   * @param {MutationRecord} mutation Mutation record
   * @returns {boolean} True if mutation is relevant
   */
  isRelevantMutation(mutation) {
    const target = mutation.target;

    // Check for tile-related changes
    if (target.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {Element} */ (target);
      const className = element.className || "";
      const id = element.id || "";

      // Look for game-related class names
      const gameRelatedTerms = [
        "tile",
        "cell",
        "grid",
        "board",
        "game",
        "score",
      ];
      const isGameRelated = gameRelatedTerms.some(
        (term) =>
          className.toLowerCase().includes(term) ||
          id.toLowerCase().includes(term)
      );

      if (isGameRelated) return true;
    }

    // Check for text content changes (score updates, tile values)
    if (mutation.type === "characterData") {
      const text = mutation.target.textContent || "";
      // Look for numeric content that might be scores or tile values
      if (/\d+/.test(text)) return true;
    }

    // Check for attribute changes on game elements
    if (mutation.type === "attributes") {
      const element = /** @type {Element} */ (mutation.target);
      const attrName = mutation.attributeName;

      // Position or style changes might indicate tile movement
      if (
        attrName === "class" ||
        attrName === "style" ||
        attrName === "data-position"
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Debounced check for actual game state changes
   * @private
   */
  debouncedCheck() {
    try {
      const currentBoard = this.adapter.readBoard();
      if (!currentBoard) return;

      const currentHash = BoardUtils.hashBoard(currentBoard);

      if (currentHash !== this.lastBoardHash) {
        this.lastBoardHash = currentHash;
        this.lastChangeTime = Date.now();
        this.changeCount++;

        if (this.onBoardChange) {
          this.onBoardChange(currentBoard, this.changeCount);
        }
      }

      // Check for game state changes (game over, score changes, etc.)
      this.checkGameStateChanges();
    } catch (error) {
      console.warn("GameMutationObserver check error:", error);
      if (this.onError) {
        this.onError(error);
      }
    }
  }

  /**
   * Check for game state changes beyond board state
   * @private
   */
  checkGameStateChanges() {
    try {
      const gameState = {
        isGameOver: this.adapter.isGameOver ? this.adapter.isGameOver() : false,
        score: this.adapter.getScore ? this.adapter.getScore() : null,
        timestamp: Date.now(),
      };

      if (this.onGameStateChange) {
        this.onGameStateChange(gameState);
      }
    } catch (error) {
      // Ignore errors in optional state checks
    }
  }

  /**
   * Find the game container element to observe
   * @private
   * @returns {Element|null} Game container element or null
   */
  findGameContainer() {
    // Try to get container from adapter if it has one
    if (this.adapter._cachedGameContainer) {
      return this.adapter._cachedGameContainer;
    }

    // Common game container selectors
    const containerSelectors = [
      ".game-container",
      ".tile-container",
      "#game-container",
      '[class*="game"]',
      '[class*="board"]',
      '[class*="grid"]',
    ];

    for (const selector of containerSelectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    // Fallback to body
    return document.body;
  }

  /**
   * Update baseline board state
   * @private
   */
  updateBaseline() {
    try {
      const board = this.adapter.readBoard();
      if (board) {
        this.lastBoardHash = BoardUtils.hashBoard(board);
      }
    } catch (error) {
      console.warn("Failed to update baseline:", error);
    }
  }

  /**
   * Get observer statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      isObserving: this.isObserving,
      changeCount: this.changeCount,
      lastChangeTime: this.lastChangeTime,
      lastBoardHash: this.lastBoardHash,
      adapterName: this.adapter ? this.adapter.getName() : null,
    };
  }

  /**
   * Reset observer state
   */
  reset() {
    this.lastBoardHash = "";
    this.lastChangeTime = 0;
    this.changeCount = 0;
    this.updateBaseline();
  }

  /**
   * Destroy observer and clean up
   */
  destroy() {
    this.stopObserving();
    this.adapter = null;
    this.onBoardChange = null;
    this.onGameStateChange = null;
    this.onError = null;
  }
}

/**
 * Create a game mutation observer with auto-detection
 * @param {Adapter} adapter Game adapter
 * @param {Object} options Observer options
 * @returns {GameMutationObserver} Observer instance
 */
export function createGameObserver(adapter, options = {}) {
  return new GameMutationObserver(adapter, options);
}
