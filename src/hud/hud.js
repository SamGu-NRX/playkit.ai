/**
 * @fileoverview Shadow DOM HUD overlay for 2048 solver
 * Breaks the HUD into controller and view layers for maintainability.
 *
 * The controller no longer derives UI state from click intent: every render
 * is driven by `control-state.js` reductions of runtime witnesses (real
 * `Runtime.getStats()` snapshots, command results, board changes). Driver
 * facts outrank stale runtime flags, stop reasons stay verbatim, and
 * pause/resume/retry controls are consequence-aware.
 */

import { detectGame } from "../adapters/index.js";
import {
  DEFAULT_DIRECTION_PRIORITY,
  DEFAULT_SOLVER_CONFIG,
  clampSolverConfig,
} from "./config.js";
import {
  createInitialControlState,
  reduceControlState,
  deriveSolverState,
  describeSolver,
  PHASE,
  SOLVER_STATE,
} from "./control-state.js";
import { HUDView } from "./view.js";

const SOLVER_COLORS = {
  [SOLVER_STATE.WASM]: "#34d399",
  [SOLVER_STATE.FALLBACK]: "#facc15",
  [SOLVER_STATE.LOADING]: "#fbbf24",
  [SOLVER_STATE.ERROR]: "#f87171",
  [SOLVER_STATE.UNKNOWN]: "#f87171",
};

const PROBLEM_LABELS = {
  "board-lost": "Board lost:",
  stalled: "Stalled:",
  "game-over": "Game over:",
  "solver-unavailable": "Solver:",
  "init-failed": "Init failed:",
  "retry-exhausted": "Retries exhausted:",
  unknown: "Stopped:",
};

const PROBLEM_COLORS = {
  "board-lost": "#fb923c",
  stalled: "#facc15",
  "game-over": "#f87171",
  "solver-unavailable": "#facc15",
  "init-failed": "#f87171",
  "retry-exhausted": "#f87171",
  unknown: "#f87171",
};

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
      onPauseToggle: this.handlePauseToggleClick.bind(this),
      onRetry: this.handleRetryClick.bind(this),
      onCollapse: this.handleCollapseToggle.bind(this),
      onDirectionPriorityChange: this.handleDirectionPriorityChange.bind(this),
      onSolverControlChange: this.handleSolverControlChange.bind(this),
    });

    this.isCollapsed = false;
    this.currentAdapter = null;
    this.controller = null;
    this.isAutoSolving = false;
    this.autoSolveTimeout = null;

    /** Witness-driven UI state; the single source of truth for rendering. */
    this.controlState = createInitialControlState();

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
   * Apply solver status indicator and synchronize controls.
   *
   * The display is derived by the shared model (`deriveSolverState`), so a
   * WASM-ready status can never be overwritten by a stale fallback error and
   * fallback reasons stay verbatim.
   * @param {Object|null} status Solver status from runtime
   */
  updateSolverStatus(status) {
    const derived = deriveSolverState(status);
    const described = describeSolver(derived);

    this.view.setSolverStatus({
      text: described.label,
      color: SOLVER_COLORS[derived.state] || "#f87171",
      title: described.title,
    });

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
   * Update HUD labels based on adapter availability, then re-render run
   * controls from the freshest witness available.
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
    } else {
      this.view.setGameStatus({ text: "Not detected", color: "#f87171" });
      this.view.setScore("-");
    }

    if (this.controller && this.controller.getSolverStatus) {
      try {
        const solverStatus = this.controller.getSolverStatus();
        this.updateSolverStatus(solverStatus || null);
      } catch (error) {
        console.warn("HUD: Failed to refresh solver status", error);
      }
    }

    // Push the freshest full witness; renderState() paints from it.
    if (this.controller && this.controller.getStats) {
      try {
        this.applyWitness(this.controller.getStats());
        return;
      } catch (error) {
        console.warn("HUD: Failed to read runtime stats", error);
      }
    }

    // Legacy/no-controller path: keep the old enabled-by-adapter behavior.
    this.view.setControlsEnabled({
      autoSolve: Boolean(this.currentAdapter),
      step: Boolean(this.currentAdapter),
    });
  }

  /**
   * Feed a runtime witness (a real `Runtime.getStats()` snapshot) into the
   * state model and re-render. This is the ONLY run-state render path when a
   * controller is connected — driver facts outrank stale runtime flags.
   * @param {Object} stats Snapshot from Runtime.getStats()
   */
  applyWitness(stats) {
    if (!stats) {
      return;
    }

    this.controlState = reduceControlState(this.controlState, {
      type: "snapshot",
      stats,
    });
    this.renderState();
  }

  /**
   * Feed a command outcome into the state model and re-render.
   * @param {string} command One of the COMMAND keys (start/stop/pause/resume/retry/detect)
   * @param {boolean} ok Whether the command succeeded
   * @param {string|null} error Error message on failure
   */
  applyCommandResult(command, ok, error = null) {
    this.controlState = reduceControlState(this.controlState, {
      type: "command-result",
      command,
      ok,
      error: error ? String(error) : null,
      stats: null,
    });
    this.renderState();
  }

  /**
   * Paint the action row, problem line, and solver line from the model.
   * @private
   */
  renderState() {
    const state = this.controlState;
    const phase = state.phase;
    const hasBoard = phase !== PHASE.NO_BOARD;
    const running = phase === PHASE.PLAYING || phase === PHASE.PAUSED;

    const nextAction = state.problem ? state.problem.nextAction : null;
    const retryKind = nextAction ? nextAction.kind : null;
    // Only detect/retry are actionable inside the HUD; new-game and reload
    // are user steps outside it (the problem text explains them).
    const retryVisible = retryKind === "detect" || retryKind === "retry";

    this.view.setRunControls({
      autoSolveLabel: running ? "⏹ Stop" : "▶️ Auto-solve",
      autoSolveEnabled: hasBoard,
      autoSolveRunning: phase === PHASE.PLAYING,
      pauseLabel: phase === PHASE.PAUSED ? "▶ Resume" : "⏸ Pause",
      pauseEnabled: phase === PHASE.PLAYING || phase === PHASE.PAUSED,
      stepEnabled: hasBoard,
      retryVisible,
      retryLabel: retryKind === "detect" ? "🔍 Re-detect" : "↻ Retry",
      retryEnabled: retryKind === "detect" ? true : state.retry.available,
    });

    if (state.problem) {
      const kind = state.problem.kind;
      this.view.setProblem({
        label: PROBLEM_LABELS[kind] || PROBLEM_LABELS.unknown,
        text: state.run.reason || state.problem.message || "",
        color: PROBLEM_COLORS[kind] || "#f87171",
      });
    } else {
      this.view.setProblem(null);
    }

    const described = describeSolver(state.solver);
    this.view.setSolverStatus({
      text: described.label,
      color: SOLVER_COLORS[state.solver.state] || "#f87171",
      title: described.title,
    });

    this.isAutoSolving = running;
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
          this.applyCommandResult("detect", false, "No game detected");
        } else {
          this.applyCommandResult("detect", true, null);
        }
      } catch (error) {
        console.warn("HUD: Controller-driven detect failed", error);
        this.showMessage("Detect failed. Check console.");
        this.applyCommandResult("detect", false, error?.message);
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
   * Handle auto-solve button click — start/stop only. The run/pause truth
   * comes from the model (driver-first), never from click intent.
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
      const phase = this.controlState.phase;
      const modelRunning = phase === PHASE.PLAYING || phase === PHASE.PAUSED;

      let currentlyRunning = modelRunning;
      if (!this.controlState.run.started && this.controller.isRunning) {
        // No witness has landed yet; fall back to the controller's flag.
        try {
          currentlyRunning = !!(await Promise.resolve(
            this.controller.isRunning()
          ));
        } catch {
          /* keep the model's answer */
        }
      }

      const command = currentlyRunning ? "stop" : "start";
      try {
        const fn = currentlyRunning
          ? this.controller.stop?.bind(this.controller)
          : this.controller.start?.bind(this.controller);
        if (fn) {
          await Promise.resolve(fn());
        }
        this.applyCommandResult(command, true, null);
        if (this.controller.getStats) {
          this.applyWitness(this.controller.getStats());
        }
      } catch (error) {
        console.warn(`HUD: Auto-solve ${command} failed via controller`, error);
        this.showMessage(
          currentlyRunning
            ? "Stop failed. Check console."
            : "Auto-solve failed. Check console.",
        );
        this.applyCommandResult(command, false, error?.message);
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
   * Handle pause/resume button click. The action follows the model's phase:
   * PLAYING → pause, PAUSED → resume; anything else is inert.
   * @private
   */
  async handlePauseToggleClick() {
    if (!this.controller) {
      this.showMessage("Pause is available only with a connected controller.");
      return;
    }

    const phase = this.controlState.phase;
    if (phase !== PHASE.PLAYING && phase !== PHASE.PAUSED) {
      return;
    }

    const command = phase === PHASE.PLAYING ? "pause" : "resume";
    try {
      const fn =
        command === "pause"
          ? this.controller.pause?.bind(this.controller)
          : this.controller.resume?.bind(this.controller);
      if (!fn) {
        throw new Error("Controller does not support pause/resume");
      }
      await Promise.resolve(fn());
      this.applyCommandResult(command, true, null);
      if (this.controller.getStats) {
        this.applyWitness(this.controller.getStats());
      }
    } catch (error) {
      console.warn("HUD: Pause/resume failed via controller", error);
      this.showMessage("Pause/resume failed. Check console.");
      this.applyCommandResult(command, false, error?.message);
    }
  }

  /**
   * Handle retry/re-detect click, following the model's prescribed action.
   * Retry re-starts the runtime (which re-detects the board itself);
   * re-detect only re-runs detection. Failures count against the model's
   * bounded retry budget.
   * @private
   */
  async handleRetryClick() {
    const nextAction = this.controlState.problem?.nextAction;
    const kind = nextAction ? nextAction.kind : null;

    if (kind === "detect") {
      await this.handleDetectClick();
      return;
    }

    if (kind !== "retry" || !this.controller) {
      return;
    }

    try {
      const startFn = this.controller.start?.bind(this.controller);
      if (startFn) {
        await Promise.resolve(startFn());
      }
      this.applyCommandResult("retry", true, null);
      if (this.controller.getStats) {
        this.applyWitness(this.controller.getStats());
      }
    } catch (error) {
      console.warn("HUD: Retry failed via controller", error);
      this.showMessage("Retry failed. Check console.");
      this.applyCommandResult("retry", false, error?.message);
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
   * Update run state UI to reflect automation status.
   *
   * Compatibility wrapper: with a connected controller this reads the REAL
   * runtime witness instead of trusting the pushed boolean — the driver may
   * have stopped itself since. Without a controller the legacy boolean path
   * is preserved for the HUD-local fallback loop.
   * @param {boolean} isRunning Whether automation is active
   */
  updateRunState(isRunning) {
    if (this.controller && this.controller.getStats) {
      try {
        this.applyWitness(this.controller.getStats());
        return;
      } catch (error) {
        console.warn("HUD: Failed to read runtime stats", error);
      }
    }

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
        this.applyCommandResult("start", true, null);
        if (this.controller.getStats) {
          this.applyWitness(this.controller.getStats());
        }
      } catch (error) {
        console.warn("HUD: startAutoSolve controller invocation failed", error);
        this.showMessage("Auto-solve failed. Check console.");
        this.applyCommandResult("start", false, error?.message);
      }
      return;
    }

    this.isAutoSolving = true;
    this.view.setAutoSolveRunning(true);
    this.autoSolveLoop();
  }

  /**
   * Suspend HUD-side timers when the page becomes hidden.
   * FIX-9 (bench finding): the visibility handler requires every managed
   * component to expose pause()/resume(); the HUD previously violated that
   * contract, so Runtime.init threw in the shipped bundle and the extension
   * never initialized. Controller-driven driving pauses via the Driver
   * itself; this only guards the HUD's local fallback loop.
   */
  pause() {
    this.visibilityPaused = true;
    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }
  }

  /**
   * Allow HUD timers again when the page becomes visible. Restarts the
   * HUD-local fallback auto-solve loop only if it was actually running.
   */
  resume() {
    this.visibilityPaused = false;
    if (this.isAutoSolving && !this.autoSolveTimeout && !this.controller) {
      this.autoSolveTimeout = setTimeout(() => {
        this.autoSolveLoop();
      }, 0);
    }
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
        this.applyCommandResult("stop", true, null);
        if (this.controller.getStats) {
          this.applyWitness(this.controller.getStats());
        }
      } catch (error) {
        console.warn("HUD: stopAutoSolve controller invocation failed", error);
        this.applyCommandResult("stop", false, error?.message);
      }
      return;
    }

    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }

    this.isAutoSolving = false;
    this.view.setAutoSolveRunning(false);
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

    if (this.controller && this.controller.getStats) {
      try {
        this.applyWitness(this.controller.getStats());
      } catch (error) {
        console.warn("HUD: Failed to read controller stats", error);
      }
    } else if (this.controller && this.controller.isRunning) {
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
    this.controlState = createInitialControlState();
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
