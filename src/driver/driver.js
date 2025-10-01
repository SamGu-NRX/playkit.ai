/**
 * @fileoverview Basic move execution system (Driver)
 * Implements naive DOM-change loop with throttling and verification
 */

import { detectGame, BoardUtils, Direction } from "../adapters/index.js";

/**
 * Driver class for automated game execution
 * Handles move execution, throttling, and change detection
 */
export class Driver {
  constructor(options = {}) {
    this.adapter = null;
    this.isRunning = false;
    this.isPaused = false;

    // Configuration
    this.config = {
      throttleMs: options.throttleMs || 130,
      domChangeTimeoutMs: options.domChangeTimeoutMs || 120,
      directionBias: options.directionBias || Direction.LEFT,
      pauseWhenHidden: options.pauseWhenHidden !== false,
      maxRetries: options.maxRetries || 3,
      stuckThreshold: options.stuckThreshold || 5,
    };

    // State tracking
    this.lastBoard = null;
    this.lastBoardHash = "";
    this.moveCount = 0;
    this.stuckCount = 0;
    this.directionPriority = [
      Direction.LEFT,
      Direction.DOWN,
      Direction.RIGHT,
      Direction.UP,
    ];

    // Callbacks
    this.onMove = null;
    this.onBoardChange = null;
    this.onGameOver = null;
    this.onError = null;

    // Bind methods
    this.tick = this.tick.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);

    // Listen for visibility changes
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /**
   * Set the adapter to use for game interaction
   * @param {Adapter} adapter Game adapter instance
   */
  setAdapter(adapter) {
    this.adapter = adapter;
    this.reset();
  }

  /**
   * Set direction priority for move attempts
   * @param {number[]} priorities Array of direction constants in priority order
   */
  setDirectionPriority(priorities) {
    if (Array.isArray(priorities) && priorities.length === 4) {
      this.directionPriority = [...priorities];
    }
  }

  /**
   * Start the automated driving loop
   */
  start() {
    if (this.isRunning) {
      console.warn("Driver already running");
      return;
    }

    if (!this.adapter) {
      throw new Error("No adapter set. Call setAdapter() first.");
    }

    this.isRunning = true;
    this.isPaused = false;
    this.reset();

    console.log("Driver started");
    this.tick();
  }

  /**
   * Stop the automated driving loop
   */
  stop() {
    this.isRunning = false;
    this.isPaused = false;
    console.log("Driver stopped");
  }

  /**
   * Pause the driving loop
   */
  pause() {
    this.isPaused = true;
    console.log("Driver paused");
  }

  /**
   * Resume the driving loop
   */
  resume() {
    if (this.isRunning && this.isPaused) {
      this.isPaused = false;
      console.log("Driver resumed");
      this.tick();
    }
  }

  /**
   * Execute a single step manually
   * @returns {Promise<boolean>} True if move was successful
   */
  async step() {
    if (!this.adapter) {
      throw new Error("No adapter set");
    }

    return await this.executeMove();
  }

  /**
   * Reset driver state
   * @private
   */
  reset() {
    this.lastBoard = null;
    this.lastBoardHash = "";
    this.moveCount = 0;
    this.stuckCount = 0;
  }

  /**
   * Main driving loop tick
   * @private
   */
  async tick() {
    if (!this.isRunning) return;

    // Pause if document is hidden and configured to do so
    if (this.config.pauseWhenHidden && document.visibilityState !== "visible") {
      setTimeout(this.tick, 250);
      return;
    }

    // Pause if explicitly paused
    if (this.isPaused) {
      setTimeout(this.tick, 250);
      return;
    }

    try {
      // Check if game is over
      if (this.adapter.isGameOver && this.adapter.isGameOver()) {
        this.stop();
        if (this.onGameOver) {
          this.onGameOver();
        }
        return;
      }

      // Execute move
      const moveSuccessful = await this.executeMove();

      if (!moveSuccessful) {
        this.stuckCount++;

        // If stuck too many times, try random moves
        if (this.stuckCount >= this.config.stuckThreshold) {
          await this.executeRandomMove();
          this.stuckCount = 0;
        }
      } else {
        this.stuckCount = 0;
      }

      // Continue loop with throttling
      setTimeout(this.tick, this.config.throttleMs);
    } catch (error) {
      console.error("Driver tick error:", error);
      if (this.onError) {
        this.onError(error);
      }

      // Continue loop even after error
      setTimeout(this.tick, this.config.throttleMs * 2);
    }
  }

  /**
   * Execute a move using direction priority
   * @private
   * @returns {Promise<boolean>} True if any move was successful
   */
  async executeMove() {
    const boardBefore = this.adapter.readBoard();
    if (!boardBefore) {
      return false;
    }

    const hashBefore = BoardUtils.hashBoard(boardBefore);

    // Try each direction in priority order
    for (const direction of this.directionPriority) {
      const success = await this.tryMove(direction, hashBefore);
      if (success) {
        this.moveCount++;
        if (this.onMove) {
          this.onMove(direction, this.moveCount);
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Try a specific move direction
   * @private
   * @param {number} direction Direction to try
   * @param {string} hashBefore Board hash before move
   * @returns {Promise<boolean>} True if move was successful
   */
  async tryMove(direction, hashBefore) {
    try {
      // Send the move
      this.adapter.sendMove(direction);

      // Wait for DOM changes
      await this.waitForDOMChange();

      // Check if board changed
      const boardAfter = this.adapter.readBoard();
      if (!boardAfter) {
        return false;
      }

      const hashAfter = BoardUtils.hashBoard(boardAfter);
      const changed = hashAfter !== hashBefore;

      if (changed) {
        this.lastBoard = boardAfter;
        this.lastBoardHash = hashAfter;

        if (this.onBoardChange) {
          this.onBoardChange(boardAfter);
        }
      }

      return changed;
    } catch (error) {
      console.warn(`Failed to execute move ${direction}:`, error);
      return false;
    }
  }

  /**
   * Execute a random move when stuck
   * @private
   * @returns {Promise<boolean>} True if move was successful
   */
  async executeRandomMove() {
    const randomDirection = Math.floor(Math.random() * 4);
    console.log(`Driver stuck, trying random direction: ${randomDirection}`);

    const boardBefore = this.adapter.readBoard();
    if (!boardBefore) return false;

    const hashBefore = BoardUtils.hashBoard(boardBefore);
    return await this.tryMove(randomDirection, hashBefore);
  }

  /**
   * Wait for DOM changes with timeout
   * @private
   * @returns {Promise<void>}
   */
  waitForDOMChange() {
    return new Promise((resolve) => {
      setTimeout(resolve, this.config.domChangeTimeoutMs);
    });
  }

  /**
   * Handle visibility change events
   * @private
   */
  handleVisibilityChange() {
    if (this.config.pauseWhenHidden && this.isRunning) {
      if (document.visibilityState === "visible") {
        console.log("Driver: Page visible, resuming");
        if (this.isPaused) {
          this.resume();
        }
      } else {
        console.log("Driver: Page hidden, pausing");
        this.pause();
      }
    }
  }

  /**
   * Get current driver statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      moveCount: this.moveCount,
      stuckCount: this.stuckCount,
      lastBoardHash: this.lastBoardHash,
      adapterName: this.adapter ? this.adapter.getName() : null,
    };
  }

  /**
   * Update configuration
   * @param {Object} newConfig Configuration updates
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Destroy driver and clean up
   */
  destroy() {
    this.stop();
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );

    this.adapter = null;
    this.onMove = null;
    this.onBoardChange = null;
    this.onGameOver = null;
    this.onError = null;
  }
}

/**
 * Create a new driver instance with auto-detection
 * @param {Object} options Driver configuration options
 * @returns {Driver} Driver instance
 */
export function createDriver(options = {}) {
  const driver = new Driver(options);

  // Auto-detect adapter if not provided
  const adapter = detectGame();
  if (adapter) {
    driver.setAdapter(adapter);
  }

  return driver;
}
