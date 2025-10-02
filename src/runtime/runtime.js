/**
 * @fileoverview Shared runtime for 2048 AI Solver
 * Single codebase that compiles to both IIFE (bookmarklet) and MV3 content script
 */

import { initHUD, getHUD, destroyHUD } from "../hud/index.js";
import { detectGame, globalAdapterRegistry } from "../adapters/index.js";
import { createDriver } from "../driver/index.js";
import { createGameObserver, getVisibilityHandler } from "../observer/index.js";
import { createSolverManager } from "../solver/index.js";

/**
 * Main runtime class for the 2048 AI Solver
 * Manages all components and provides unified interface
 */
export class Runtime {
  constructor(options = {}) {
    this.options = {
      autoInit: options.autoInit !== false,
      enableHUD: options.enableHUD !== false,
      enableVisibilityHandling: options.enableVisibilityHandling !== false,
      enableMutationObserver: options.enableMutationObserver !== false,
      ...options,
    };

    // Component instances
    this.hud = null;
    this.driver = null;
    this.observer = null;
    this.visibilityHandler = null;
    this.currentAdapter = null;
    this.directionPriority = null;
    this.solverManager = createSolverManager(options.solver || {});

    // State
    this.isInitialized = false;
    this.isRunning = false;

    // Bind methods
    this.handleBoardChange = this.handleBoardChange.bind(this);
    this.handleGameOver = this.handleGameOver.bind(this);
    this.handleError = this.handleError.bind(this);
  }

  /**
   * Initialize the runtime
   */
  async init() {
    if (this.isInitialized) {
      console.warn("Runtime already initialized");
      return;
    }

    console.log("Initializing 2048 AI Solver Runtime...");

    try {
      // Initialize visibility handler first
      if (this.options.enableVisibilityHandling) {
        this.visibilityHandler = getVisibilityHandler();
      }

      // Initialize HUD
      if (this.options.enableHUD) {
        this.hud = initHUD();
        if (this.hud) {
          this.hud.setController(this._createHUDController());
          this.directionPriority = this.hud.getDirectionPriority();
        }

        // Connect HUD to visibility handler
        if (this.visibilityHandler) {
          this.visibilityHandler.addManagedComponent(this.hud, "HUD");
        }
      }

      // Kick off solver initialization in the background
      if (this.solverManager) {
        this.solverManager
          .initialize()
          .catch((error) => {
            console.warn("Runtime: solver initialization failed", error);
          })
          .finally(() => {
            this._notifySolverStatus();
          });
      }

      // Try to detect game
      this.detectGame();

      this.isInitialized = true;
      console.log("Runtime initialized successfully");

      // Auto-start if configured
      if (this.options.autoInit && this.currentAdapter) {
        this.setupComponents();
      }
    } catch (error) {
      console.error("Runtime initialization failed:", error);
      throw error;
    }
  }

  /**
   * Detect game and set up adapter
   */
  detectGame() {
    this.currentAdapter = detectGame();

    if (this.currentAdapter) {
      console.log(`Game detected: ${this.currentAdapter.getName()}`);

      // Update HUD if available
      if (this.hud) {
        this.hud.currentAdapter = this.currentAdapter;
        this.hud.updateStatus();
      }

      return true;
    } else {
      console.log("No game detected");
      return false;
    }
  }

  /**
   * Set up all components after game detection
   * @private
   */
  setupComponents() {
    if (!this.currentAdapter) {
      console.warn("Cannot setup components without adapter");
      return;
    }

    // Create driver
    this.driver = createDriver({
      throttleMs: 130,
      domChangeTimeoutMs: 120,
      pauseWhenHidden: this.options.enableVisibilityHandling,
    });

    this.driver.setAdapter(this.currentAdapter);

    if (this.solverManager) {
      this.driver.setSolverEngine(this.solverManager);
      this._notifySolverStatus();
    }

    // Apply direction priority from HUD/user selection if available
    if (this.hud) {
      this.directionPriority = this.hud.getDirectionPriority();
    }
    if (this.directionPriority) {
      this.driver.setDirectionPriority([...this.directionPriority]);
    }

    // Set up driver callbacks
    this.driver.onBoardChange = this.handleBoardChange;
    this.driver.onGameOver = this.handleGameOver;
    this.driver.onError = this.handleError;

    // Create mutation observer
    if (this.options.enableMutationObserver) {
      this.observer = createGameObserver(this.currentAdapter);
      this.observer.onBoardChange = this.handleBoardChange;
      this.observer.startObserving();
    }

    // Add driver to visibility handler
    if (this.visibilityHandler) {
      this.visibilityHandler.addManagedComponent(this.driver, "Driver");
    }

    console.log("Components set up successfully");
  }

  /**
   * Start automated solving
   */
  start() {
    if (!this.isInitialized) {
      throw new Error("Runtime not initialized. Call init() first.");
    }

    if (!this.currentAdapter) {
      const detected = this.detectGame();
      if (!detected) {
        throw new Error("No game detected. Cannot start automation.");
      }
      this.setupComponents();
    }

    if (!this.driver) {
      this.setupComponents();
    }

    if (this.isRunning) {
      console.warn("Runtime already running");
      return;
    }

    this.driver.start();
    this.isRunning = true;

    if (this.hud) {
      this.hud.updateRunState(true);
    }

    console.log("Runtime started");
  }

  /**
   * Stop automated solving
   */
  stop() {
    if (!this.isRunning) {
      console.warn("Runtime not running");
      return;
    }

    if (this.driver) {
      this.driver.stop();
    }

    this.isRunning = false;
    if (this.hud) {
      this.hud.updateRunState(false);
    }
    console.log("Runtime stopped");
  }

  /**
   * Pause automated solving
   */
  pause() {
    if (this.driver && this.isRunning) {
      this.driver.pause();
      this.isRunning = false;
      console.log("Runtime paused");
      if (this.hud) {
        this.hud.updateRunState(false);
      }
    }
  }

  /**
   * Resume automated solving
   */
  resume() {
    if (this.driver && !this.isRunning) {
      this.driver.resume();
      this.isRunning = true;
      console.log("Runtime resumed");
      if (this.hud) {
        this.hud.updateRunState(true);
      }
    }
  }

  /**
   * Execute a single step
   * @returns {Promise<boolean>} True if step was successful
   */
  async step() {
    if (!this.currentAdapter) {
      const detected = this.detectGame();
      if (!detected) {
        throw new Error("No game detected");
      }
      this.setupComponents();
    }

    if (!this.driver) {
      this.setupComponents();
    }

    return await this.driver.step();
  }

  /**
   * Handle board change events
   * @private
   * @param {number[][]} board New board state
   */
  handleBoardChange(board) {
    // Update HUD if available
    if (this.hud) {
      this.hud.updateStatus();
    }

    // Log board change
    console.log("Board changed:", board);
  }

  /**
   * Handle game over events
   * @private
   */
  handleGameOver() {
    console.log("Game over detected");
    this.stop();

    // Show message if HUD is available
    if (this.hud) {
      this.hud.showMessage("Game Over!");
    }
  }

  /**
   * Handle error events
   * @private
   * @param {Error} error Error object
   */
  handleError(error) {
    console.error("Runtime error:", error);

    // Show error message if HUD is available
    if (this.hud) {
      this.hud.showMessage(`Error: ${error.message}`);
    }

    this._notifySolverStatus();
  }

  /**
   * Create controller interface for HUD interactions
   * @private
   * @returns {Object} Controller API used by HUD
   */
  _createHUDController() {
    return {
      detectGame: () => this.detectGame(),
      start: () => this.start(),
      stop: () => this.stop(),
      step: () => this.step(),
      isRunning: () => this.isRunning,
      getCurrentAdapter: () => this.currentAdapter,
      getSolverStatus: () =>
        this.solverManager ? this.solverManager.getStatus() : null,
      setDirectionPriority: (priorities) => {
        if (Array.isArray(priorities) && priorities.length === 4) {
          this.directionPriority = [...priorities];
          if (this.driver) {
            this.driver.setDirectionPriority([...priorities]);
          }
        }
      },
      setSolverStrategy: (strategy) => this.setSolverStrategy(strategy),
    };
  }

  /**
   * Get runtime statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      isInitialized: this.isInitialized,
      isRunning: this.isRunning,
      adapterName: this.currentAdapter ? this.currentAdapter.getName() : null,
      driverStats: this.driver ? this.driver.getStats() : null,
      observerStats: this.observer ? this.observer.getStats() : null,
      visibilityStats: this.visibilityHandler
        ? this.visibilityHandler.getStats()
        : null,
      solver: this.solverManager ? this.solverManager.getStatus() : null,
    };
  }

  /**
   * Update solver configuration from HUD/controller
   * @param {Object} strategy Strategy configuration object
   */
  async setSolverStrategy(strategy) {
    if (!this.solverManager) {
      return;
    }

    try {
      await this.solverManager.setStrategy(strategy);
    } catch (error) {
      console.warn("Runtime: failed to apply solver strategy", error);
    }

    this._notifySolverStatus();
  }

  /**
   * Get current solver status snapshot
   * @returns {Object|null}
   */
  getSolverStatus() {
    return this.solverManager ? this.solverManager.getStatus() : null;
  }

  /**
   * Push solver status updates to HUD if available
   * @private
   */
  _notifySolverStatus() {
    if (this.hud && typeof this.hud.updateSolverStatus === "function") {
      this.hud.updateSolverStatus(this.getSolverStatus());
    }
  }

  /**
   * Destroy runtime and clean up all components
   */
  destroy() {
    console.log("Destroying runtime...");

    this.stop();

    // Destroy components
    if (this.driver) {
      this.driver.destroy();
      this.driver = null;
    }

    if (this.observer) {
      this.observer.destroy();
      this.observer = null;
    }

    if (this.hud) {
      this.hud.setController(null);
      destroyHUD();
      this.hud = null;
    }

    if (this.visibilityHandler) {
      this.visibilityHandler.destroy();
      this.visibilityHandler = null;
    }

    this.solverManager = createSolverManager(this.options.solver || {});

    // Clear adapter
    this.currentAdapter = null;

    // Reset state
    this.isInitialized = false;
    this.isRunning = false;

    console.log("Runtime destroyed");
  }
}

/**
 * Global runtime instance
 */
let globalRuntime = null;

/**
 * Initialize global runtime instance
 * @param {Object} options Runtime options
 * @returns {Runtime} Runtime instance
 */
export async function initRuntime(options = {}) {
  if (globalRuntime) {
    console.warn("Global runtime already exists");
    return globalRuntime;
  }

  globalRuntime = new Runtime(options);
  await globalRuntime.init();
  return globalRuntime;
}

/**
 * Get global runtime instance
 * @returns {Runtime|null} Runtime instance or null
 */
export function getRuntime() {
  return globalRuntime;
}

/**
 * Destroy global runtime instance
 */
export function destroyRuntime() {
  if (globalRuntime) {
    globalRuntime.destroy();
    globalRuntime = null;
  }
}

/**
 * Quick start function for immediate use
 * @param {Object} options Runtime options
 * @returns {Promise<Runtime>} Runtime instance
 */
export async function quickStart(options = {}) {
  const runtime = await initRuntime(options);

  // Try to start immediately if game is detected
  try {
    runtime.start();
  } catch (error) {
    console.log("Could not auto-start:", error.message);
  }

  return runtime;
}
