/**
 * @fileoverview Shadow DOM HUD overlay for 2048 solver
 * Breaks the HUD into controller and view layers for maintainability.
 */

import { detectGame } from "../adapters/index.js";
import {
  DEFAULT_DIRECTION_PRIORITY,
  DEFAULT_SOLVER_CONFIG,
  clampSolverConfig,
} from "./config.js";
import { HUDView } from "./view.js";

/**
 * HUD overlay controller coordinates the runtime interactions while delegating
 * DOM management to {@link HUDView}.
 */
export class HUD {
  constructor() {
    this.view = new HUDView({
      onDetect: this.handleDetectClick.bind(this),
      onAutoSolve: this.handleAutoSolveClick.bind(this),
      onStep: this.handleStepClick.bind(this),
      onCollapse: this.handleCollapseToggle.bind(this),
      onDirectionPriorityChange: this.handleDirectionPriorityChange.bind(this),
      onSolverControlChange: this.handleSolverControlChange.bind(this),
    });

    this.isCollapsed = false;
    this.currentAdapter = null;
    this.controller = null;
    this.isAutoSolving = false;
    this.autoSolveTimeout = null;

    this.directionPriority = [...DEFAULT_DIRECTION_PRIORITY];
    this.solverConfig = { ...DEFAULT_SOLVER_CONFIG };

    this.isInitialized = false;
  }

  /**
   * Initialize and inject the HUD into the page
   */
  init() {
    if (this.isInitialized) {
      console.warn("HUD already initialized");
      return;
    }

    this.view.mount();
    this.view.setDirectionPriority(this.directionPriority);
    this.view.setSolverControlValues(this.solverConfig);
    this.applySolverControlState();

    this.updateStatus();
    this.updateSolverStatus(null);

    this.isInitialized = true;

    console.log("HUD initialized");
  }

  /**
   * Enable/disable solver inputs based on selected strategy
   * @private
   */
  applySolverControlState() {
    const isProbability = this.solverConfig.type === "expectimax-probability";
    this.view.setSolverControlAvailability(!isProbability, isProbability);
  }

  /**
   * Handle updates to solver configuration controls
   * @private
   * @param {{type:string, heuristic:string, depth:number, probability:number}} nextConfig
   */
  handleSolverControlChange(nextConfig) {
    const clamped = clampSolverConfig(nextConfig);

    this.solverConfig = {
      ...this.solverConfig,
      ...nextConfig,
      depth: clamped.depth,
      probability: clamped.probability,
    };

    this.view.setSolverControlValues(this.solverConfig);
    this.applySolverControlState();

    if (this.controller && this.controller.setSolverStrategy) {
      try {
        this.controller.setSolverStrategy({ ...this.solverConfig });
      } catch (error) {
        console.warn("HUD: Failed to update solver strategy", error);
      }
    }
  }

  /**
   * Apply solver status indicator and synchronize controls
   * @param {Object|null} status Solver status from runtime
   */
  updateSolverStatus(status) {
    const state = {
      text: "Initializing…",
      color: "#fbbf24",
      title: "Solver is starting",
    };

    if (status) {
      if (status.status === "ready" && status.mode === "wasm") {
        state.text = "WASM ready";
        state.color = "#34d399";
        state.title = "Native solver active";
      } else if (status.status === "ready" || status.mode === "fallback") {
        state.text = "Fallback";
        state.color = "#facc15";
        state.title = "Using JS fallback solver";
      } else if (status.status === "fallback") {
        state.text = "Fallback";
        state.color = "#facc15";
        state.title = "Using JS fallback solver";
      } else if (status.status === "error") {
        state.text = "Error";
        state.color = "#f87171";
        state.title = status.lastError ? String(status.lastError) : "Solver error";
      } else if (status.status === "idle" || status.status === "loading") {
        state.text = "Loading…";
        state.color = "#fbbf24";
        state.title = "Loading solver";
      }

      if (status.lastError) {
        state.title = `Fallback: ${status.lastError}`;
      }
    }

    this.view.setSolverStatus(state);

    if (status && status.strategy) {
      const clamped = clampSolverConfig(status.strategy);
      this.solverConfig = {
        ...this.solverConfig,
        ...status.strategy,
        depth: clamped.depth,
        probability: clamped.probability,
      };

      this.view.setSolverControlValues(this.solverConfig);
      this.applySolverControlState();
    }
  }

  /**
   * Update HUD labels based on adapter availability
   */
  updateStatus() {
    if (this.controller && this.controller.getCurrentAdapter) {
      const controllerAdapter = this.controller.getCurrentAdapter();
      if (controllerAdapter) {
        this.currentAdapter = controllerAdapter;
      }
    }

    if (this.currentAdapter) {
      this.view.setGameStatus({
        text: `${this.currentAdapter.getName()}`,
        color: "#34d399",
      });

      const score = this.currentAdapter.getScore();
      this.view.setScore(score !== null ? score.toLocaleString() : "-");
      this.view.setControlsEnabled({ autoSolve: true, step: true });
    } else {
      this.view.setGameStatus({ text: "Not detected", color: "#f87171" });
      this.view.setScore("-");
      this.view.setControlsEnabled({ autoSolve: false, step: false });
    }

    if (this.controller && this.controller.getSolverStatus) {
      try {
        const solverStatus = this.controller.getSolverStatus();
        this.updateSolverStatus(solverStatus || null);
      } catch (error) {
        console.warn("HUD: Failed to refresh solver status", error);
      }
    }
  }

  /**
   * Handle direction priority changes from the UI.
   * @private
   * @param {number[]} priorities
   */
  handleDirectionPriorityChange(priorities) {
    if (!Array.isArray(priorities) || priorities.length === 0) {
      return;
    }

    this.directionPriority = priorities;

    if (this.controller && this.controller.setDirectionPriority) {
      try {
        this.controller.setDirectionPriority([...priorities]);
      } catch (error) {
        console.warn("HUD: Failed to update direction priority via controller", error);
      }
    }
  }

  /**
   * Handle collapse button toggle to update local state.
   * @param {boolean} isCollapsed
   * @private
   */
  handleCollapseToggle(isCollapsed) {
    this.isCollapsed = Boolean(isCollapsed);
  }

  /**
   * Handle detect game button click
   * @private
   */
  async handleDetectClick() {
    if (this.controller) {
      try {
        const detectFn = this.controller.detectGame?.bind(this.controller);
        const detected = detectFn ? await Promise.resolve(detectFn()) : false;
        if (this.controller.getCurrentAdapter) {
          const adapterFromController = this.controller.getCurrentAdapter();
          if (adapterFromController) {
            this.currentAdapter = adapterFromController;
          }
        }
        this.updateStatus();
        if (!detected && !this.currentAdapter) {
          this.showMessage("No game detected.");
        }
      } catch (error) {
        console.warn("HUD: Controller-driven detect failed", error);
        this.showMessage("Detect failed. Check console.");
      }
      return;
    }

    this.currentAdapter = detectGame();
    this.updateStatus();

    if (!this.currentAdapter) {
      this.showMessage("No game detected.");
    }
  }

  /**
   * Handle auto-solve button click
   * @private
   */
  async handleAutoSolveClick() {
    if (!this.currentAdapter) {
      await this.handleDetectClick();
      if (!this.currentAdapter) {
        this.showMessage('No game detected. Click "Detect Game" first.');
        return;
      }
    }

    if (this.controller) {
      try {
        const isRunning = this.controller.isRunning?.bind(this.controller);
        const currentlyRunning = isRunning ? !!isRunning() : this.isAutoSolving;

        if (currentlyRunning) {
          const stopFn = this.controller.stop?.bind(this.controller);
          if (stopFn) {
            await Promise.resolve(stopFn());
          }
          this.updateRunState(false);
        } else {
          const startFn = this.controller.start?.bind(this.controller);
          if (startFn) {
            await Promise.resolve(startFn());
          }
          this.updateRunState(true);
        }
      } catch (error) {
        console.warn("HUD: Failed to toggle auto-solve via controller", error);
        this.showMessage("Auto-solve toggle failed. Check console.");
      }
      return;
    }

    if (this.isAutoSolving) {
      this.stopAutoSolve();
    } else {
      this.startAutoSolve();
    }
  }

  /**
   * Handle step button click
   * @private
   */
  async handleStepClick() {
    if (!this.currentAdapter) {
      await this.handleDetectClick();
      if (!this.currentAdapter) {
        this.showMessage('No game detected. Click "Detect Game" first.');
        return;
      }
    }

    if (this.controller) {
      try {
        const stepFn = this.controller.step?.bind(this.controller);
        if (stepFn) {
          await Promise.resolve(stepFn());
        }
      } catch (error) {
        console.warn("HUD: Step failed via controller", error);
        this.showMessage("Step failed. Check console.");
      }
      return;
    }

    await this.executeStep();
    this.updateStatus();
  }

  /**
   * Update run state UI to reflect automation status
   * @param {boolean} isRunning Whether automation is active
   */
  updateRunState(isRunning) {
    this.isAutoSolving = !!isRunning;
    this.view.setAutoSolveRunning(this.isAutoSolving);
  }

  /**
   * Start auto-solving
   * @private
   */
  async startAutoSolve() {
    if (this.controller) {
      try {
        const startFn = this.controller.start?.bind(this.controller);
        if (startFn) {
          await Promise.resolve(startFn());
        }
        const running = this.controller.isRunning?.bind(this.controller);
        this.updateRunState(running ? !!running() : true);
      } catch (error) {
        console.warn("HUD: startAutoSolve controller invocation failed", error);
        this.showMessage("Auto-solve failed. Check console.");
      }
      return;
    }

    this.updateRunState(true);
    this.autoSolveLoop();
  }

  /**
   * Stop auto-solving
   * @private
   */
  async stopAutoSolve() {
    if (this.controller) {
      try {
        const stopFn = this.controller.stop?.bind(this.controller);
        if (stopFn) {
          await Promise.resolve(stopFn());
        }
      } catch (error) {
        console.warn("HUD: stopAutoSolve controller invocation failed", error);
      }
      this.updateRunState(false);
      return;
    }

    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }

    this.updateRunState(false);
  }

  /**
   * Auto-solve loop
   * @private
   */
  async autoSolveLoop() {
    if (!this.isAutoSolving || !this.currentAdapter) return;

    if (this.currentAdapter.isGameOver()) {
      this.stopAutoSolve();
      this.showMessage("Game over!");
      return;
    }

    await this.executeStep();
    this.updateStatus();

    this.autoSolveTimeout = setTimeout(() => {
      this.autoSolveLoop();
    }, 150);
  }

  /**
   * Execute a single move iteration
   * @private
   */
  async executeStep() {
    if (!this.currentAdapter) return;

    const boardBefore = this.currentAdapter.readBoard();
    if (!boardBefore) return;

    for (const direction of this.directionPriority) {
      this.currentAdapter.sendMove(direction);

      await new Promise((resolve) => setTimeout(resolve, 120));

      const boardAfter = this.currentAdapter.readBoard();
      if (
        boardAfter &&
        JSON.stringify(boardBefore) !== JSON.stringify(boardAfter)
      ) {
        return;
      }
    }

    const randomDir = Math.floor(Math.random() * 4);
    this.currentAdapter.sendMove(randomDir);
  }

  /**
   * Show temporary message via the view layer
   * @private
   * @param {string} message
   */
  showMessage(message) {
    this.view.showMessage(message);
  }

  /**
   * Connect HUD to external controller (e.g., runtime)
   * @param {Object|null} controller Controller interface
   */
  setController(controller) {
    this.controller = controller || null;

    if (this.controller && this.controller.getCurrentAdapter) {
      const adapter = this.controller.getCurrentAdapter();
      if (adapter) {
        this.currentAdapter = adapter;
      }
    }

    if (this.controller && this.controller.isRunning) {
      try {
        this.updateRunState(!!this.controller.isRunning());
      } catch (error) {
        console.warn("HUD: Failed to read controller run state", error);
      }
    } else {
      this.updateRunState(false);
    }

    this.updateStatus();

    if (this.controller && this.controller.getSolverStatus) {
      try {
        const solverStatus = this.controller.getSolverStatus();
        this.updateSolverStatus(solverStatus || null);
      } catch (error) {
        console.warn("HUD: Failed to fetch solver status", error);
      }
    } else {
      this.updateSolverStatus(null);
    }
  }

  /**
   * Get current direction priority selection
   * @returns {number[]} Direction priority array
   */
  getDirectionPriority() {
    return [...this.directionPriority];
  }

  /**
   * Destroy the HUD and clean up
   */
  destroy() {
    if (this.isAutoSolving) {
      this.stopAutoSolve();
    }

    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }

    this.view.destroy();

    this.currentAdapter = null;
    this.controller = null;
    this.isInitialized = false;
  }
}

/**
 * Global HUD instance
 */
let globalHUD = null;

/**
 * Initialize HUD if not already present
 * @returns {HUD} HUD instance
 */
export function initHUD() {
  if (!globalHUD) {
    globalHUD = new HUD();
    globalHUD.init();
  }
  return globalHUD;
}

/**
 * Get current HUD instance
 * @returns {HUD|null} HUD instance or null
 */
export function getHUD() {
  return globalHUD;
}

/**
 * Destroy current HUD instance
 */
export function destroyHUD() {
  if (globalHUD) {
    globalHUD.destroy();
    globalHUD = null;
  }
}
