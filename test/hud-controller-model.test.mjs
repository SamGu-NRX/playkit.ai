/**
 * HUD controller tests against the witness-driven control-state model
 * (src/hud/hud.js). The DOM view is replaced with a recording double; the
 * controller can be a fake or the REAL Runtime under the DOM shim.
 *
 * Pins the milestone-2 contract: renders follow the model (driver facts
 * outrank stale runtime flags and click intent), pause/resume/retry controls
 * exist and act per the model's phase and prescribed next action, stop
 * reasons stay verbatim, and a WASM-ready solver line is never overwritten
 * by a stale fallback error.
 *
 * Run: node --test test/hud-controller-model.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { HUD } from "../src/hud/hud.js";
import { Runtime } from "../src/runtime/runtime.js";
import { createSolverManager } from "../src/solver/solver-manager.js";
import { installDomShim } from "./helpers/dom-shim.mjs";
import { PHASE, RETRY_LIMIT } from "../src/hud/control-state.js";

/** Recording view double: captures every setter call. */
function makeFakeView() {
  const calls = { runControls: [], problems: [], solver: [], autoSolveRunning: [] };
  return {
    calls,
    setRunControls(controls) {
      calls.runControls.push(controls);
    },
    setProblem(problem) {
      calls.problems.push(problem);
    },
    setSolverStatus(status) {
      calls.solver.push(status);
    },
    setAutoSolveRunning(isRunning) {
      calls.autoSolveRunning.push(isRunning);
    },
    setGameStatus() {},
    setScore() {},
    setControlsEnabled() {},
    setDirectionPriority() {},
    setSolverControlValues() {},
    setSolverControlAvailability() {},
    showMessage(message) {
      calls.lastMessage = message;
    },
    mount() {},
    destroy() {},
  };
}

function makeFakeController(overrides = {}) {
  return {
    detectGameCalls: 0,
    startCalls: 0,
    stopCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    ...overrides,
  };
}

/** Witness builders matching the real Runtime.getStats() shape. */
function witness(over = {}) {
  return {
    isInitialized: true,
    isRunning: false,
    adapterName: "Fixture 2048",
    driverStats: {
      isRunning: false,
      isPaused: false,
      moveCount: 0,
      stopReason: null,
      ...over.driverStats,
    },
    solver: {
      status: "ready",
      mode: "fallback",
      lastError: null,
      strategy: {},
      wasm: null,
      naive: { status: "ready" },
      ...over.solver,
    },
    ...over.top,
  };
}

describe("HUD controller renders from the model", () => {
  let hud;
  let view;

  beforeEach(() => {
    hud = new HUD();
    view = makeFakeView();
    hud.view = view;
  });

  afterEach(() => {
    hud.destroy();
  });

  test("stale runtime flag + driver stopped → STOPPED controls with verbatim reason", () => {
    hud.applyWitness(
      witness({
        top: { isRunning: true }, // the stale runtime flag
        driverStats: {
          isRunning: false,
          stopReason: "no board progress for 20 consecutive ticks",
          moveCount: 42,
        },
      })
    );

    const controls = view.calls.runControls.at(-1);
    assert.equal(controls.autoSolveLabel, "▶️ Auto-solve");
    assert.equal(controls.autoSolveEnabled, true);
    assert.equal(controls.pauseEnabled, false);
    assert.equal(controls.retryVisible, true);
    assert.equal(controls.retryLabel, "↻ Retry");
    assert.equal(controls.retryEnabled, true);

    const problem = view.calls.problems.at(-1);
    assert.equal(problem.label, "Stalled:");
    assert.equal(problem.text, "no board progress for 20 consecutive ticks");
  });

  test("game over witness → retry hidden, verbatim 'game over' reason", () => {
    hud.applyWitness(
      witness({
        driverStats: { isRunning: false, stopReason: "game over", moveCount: 9 },
      })
    );

    const controls = view.calls.runControls.at(-1);
    assert.equal(controls.retryVisible, false);

    const problem = view.calls.problems.at(-1);
    assert.equal(problem.label, "Game over:");
    assert.equal(problem.text, "game over");
    assert.equal(problem.color, "#f87171");
  });

  test("board-lost witness → re-detect offered and enabled", () => {
    hud.applyWitness(
      witness({
        driverStats: {
          isRunning: false,
          stopReason: "abandoned after 3 consecutive failed board reads",
        },
      })
    );

    const controls = view.calls.runControls.at(-1);
    assert.equal(controls.retryVisible, true);
    assert.equal(controls.retryLabel, "🔍 Re-detect");
    assert.equal(controls.retryEnabled, true);
  });

  test("playing witness → pause enabled, stop label; paused witness → resume label", () => {
    hud.applyWitness(
      witness({
        top: { isRunning: true },
        driverStats: { isRunning: true, isPaused: false, moveCount: 3 },
      })
    );
    let controls = view.calls.runControls.at(-1);
    assert.equal(controls.autoSolveLabel, "⏹ Stop");
    assert.equal(controls.pauseLabel, "⏸ Pause");
    assert.equal(controls.pauseEnabled, true);

    hud.applyWitness(
      witness({
        top: { isRunning: false },
        driverStats: { isRunning: true, isPaused: true, moveCount: 3 },
      })
    );
    controls = view.calls.runControls.at(-1);
    assert.equal(controls.autoSolveLabel, "⏹ Stop");
    assert.equal(controls.pauseLabel, "▶ Resume");
    assert.equal(controls.pauseEnabled, true);
  });

  test("clearing the problem: a fresh running witness hides the retry button", () => {
    hud.applyWitness(
      witness({
        driverStats: { isRunning: false, stopReason: "no board progress for 20 consecutive ticks" },
      })
    );
    assert.equal(view.calls.runControls.at(-1).retryVisible, true);

    hud.applyWitness(
      witness({
        top: { isRunning: true },
        driverStats: { isRunning: true, moveCount: 44, stopReason: null },
      })
    );
    const controls = view.calls.runControls.at(-1);
    assert.equal(controls.retryVisible, false);
    assert.equal(view.calls.problems.at(-1), null);
  });
});

describe("HUD controller acts per the model", () => {
  let hud;
  let view;
  let controller;

  beforeEach(() => {
    hud = new HUD();
    view = makeFakeView();
    hud.view = view;
  });

  afterEach(() => {
    hud.destroy();
  });

  test("auto-solve click on a PLAYING witness stops (driver-first), not clicks-intent", async () => {
    controller = makeFakeController({
      isRunning: () => false, // stale runtime flag says NOT running
      getStats: () =>
        witness({
          top: { isRunning: true },
          driverStats: { isRunning: true, moveCount: 5 },
        }),
      stop() {
        this.stopCalls++;
      },
    });
    hud.currentAdapter = { getName: () => "F", getScore: () => 0 };
    hud.setController(controller);

    await hud.handleAutoSolveClick();
    assert.equal(controller.stopCalls, 1);
    assert.equal(controller.startCalls, 0);
  });

  test("auto-solve click on a STOPPED witness starts", async () => {
    controller = makeFakeController({
      isRunning: () => false,
      getStats: () =>
        witness({
          driverStats: {
            isRunning: false,
            stopReason: "no board progress for 20 consecutive ticks",
          },
        }),
      start() {
        this.startCalls++;
      },
    });
    hud.currentAdapter = { getName: () => "F", getScore: () => 0 };
    hud.setController(controller);

    await hud.handleAutoSolveClick();
    assert.equal(controller.startCalls, 1);
    assert.equal(controller.stopCalls, 0);
  });

  test("pause click while PLAYING calls controller.pause and re-renders from the witness", async () => {
    let paused = false;
    controller = makeFakeController({
      getStats: () =>
        paused
          ? witness({
              top: { isRunning: false },
              driverStats: { isRunning: true, isPaused: true, moveCount: 5 },
            })
          : witness({
              top: { isRunning: true },
              driverStats: { isRunning: true, isPaused: false, moveCount: 5 },
            }),
      pause() {
        paused = true;
        this.pauseCalls++;
      },
      resume() {
        paused = false;
        this.resumeCalls++;
      },
    });
    hud.currentAdapter = { getName: () => "F", getScore: () => 0 };
    hud.setController(controller);

    await hud.handlePauseToggleClick();
    assert.equal(controller.pauseCalls, 1);
    assert.equal(view.calls.runControls.at(-1).pauseLabel, "▶ Resume");

    await hud.handlePauseToggleClick();
    assert.equal(controller.resumeCalls, 1);
    assert.equal(view.calls.runControls.at(-1).pauseLabel, "⏸ Pause");
  });

  test("retry click on a stalled problem restarts via controller.start", async () => {
    controller = makeFakeController({
      isRunning: () => false,
      getStats: () =>
        witness({
          driverStats: {
            isRunning: false,
            stopReason: "no board progress for 20 consecutive ticks",
          },
        }),
      start() {
        this.startCalls++;
      },
    });
    hud.currentAdapter = { getName: () => "F", getScore: () => 0 };
    hud.setController(controller);

    await hud.handleRetryClick();
    assert.equal(controller.startCalls, 1);
  });

  test("repeated retry failures exhaust the model's bounded retry budget", () => {
    for (let i = 0; i < RETRY_LIMIT; i++) {
      hud.applyCommandResult("retry", false, "start failed");
    }

    // Budget spent: the model prescribes a page reload, a user step
    // outside the HUD — the button hides instead of disabling.
    const problem = view.calls.problems.at(-1);
    assert.equal(problem.label, "Retries exhausted:");
    assert.match(problem.text, /exhausted after 2 attempts/);
  });
});

describe("HUD solver line derives from the model", () => {
  let hud;
  let view;

  beforeEach(() => {
    hud = new HUD();
    view = makeFakeView();
    hud.view = view;
  });

  afterEach(() => {
    hud.destroy();
  });

  test("WASM-ready is never overwritten by a stale lastError", () => {
    hud.updateSolverStatus({
      status: "ready",
      mode: "wasm",
      lastError: "stale error from an earlier run",
      strategy: {},
      wasm: { status: "ready" },
      naive: { status: "ready" },
    });

    const shown = view.calls.solver.at(-1);
    assert.equal(shown.text, "WASM");
    assert.equal(shown.color, "#34d399");
    assert.notEqual(shown.title.startsWith("Fallback:"), true);
  });

  test("fallback keeps the verbatim reason in the title", () => {
    hud.updateSolverStatus({
      status: "fallback",
      mode: "fallback",
      lastError: "Failed to load module: /nonexistent.mjs",
      strategy: {},
      wasm: { status: "error", lastError: "Failed to load module: /nonexistent.mjs" },
      naive: { status: "ready" },
    });

    const shown = view.calls.solver.at(-1);
    assert.equal(shown.text, "Fallback");
    assert.equal(shown.color, "#facc15");
    assert.ok(shown.title.includes("Failed to load module: /nonexistent.mjs"));
  });
});

describe("HUD updateRunState compatibility", () => {
  test("without a controller, the legacy boolean path is preserved", () => {
    const hud = new HUD();
    const view = makeFakeView();
    hud.view = view;

    hud.updateRunState(true);
    assert.deepEqual(view.calls.autoSolveRunning, [true]);
    assert.equal(hud.isAutoSolving, true);
    hud.destroy();
  });

  test("with a controller exposing getStats, the boolean is ignored in favor of the witness", () => {
    const hud = new HUD();
    const view = makeFakeView();
    hud.view = view;

    const controller = makeFakeController({
      isRunning: () => true, // lies
      getStats: () =>
        witness({
          driverStats: {
            isRunning: false,
            stopReason: "abandoned after 3 consecutive failed board reads",
          },
        }),
    });
    hud.currentAdapter = { getName: () => "F", getScore: () => 0 };
    hud.setController(controller);

    hud.updateRunState(true); // the runtime's pushed boolean

    const problem = view.calls.problems.at(-1);
    assert.equal(problem.label, "Board lost:");
    assert.equal(view.calls.runControls.at(-1).autoSolveLabel, "▶️ Auto-solve");
    hud.destroy();
  });
});

describe("HUD wired to the REAL runtime under the DOM shim", () => {
  test("driver self-stop reaches the HUD as a STOPPED render with the verbatim reason", async () => {
    const dom = installDomShim();
    try {
      const runtime = new Runtime({
        autoInit: false,
        enableHUD: false,
        enableVisibilityHandling: false,
        enableMutationObserver: false,
        solver: { disableWasm: true },
      });
      runtime.isInitialized = true;
      runtime.currentAdapter = {
        getName: () => "Fixture 2048",
        getScore: () => 12,
        isGameOver: () => false,
        readBoard: () => null, // every read fails → bounded abandonment
        sendMove: () => {},
      };
      runtime.setupComponents();
      runtime.driver.config.throttleMs = 10;
      runtime.driver.config.domChangeTimeoutMs = 5;
      runtime.driver.config.maxNoProgressTicks = 50;

      const hud = new HUD();
      const view = makeFakeView();
      hud.view = view;

      // The controller interface handed to the HUD by the runtime.
      hud.setController(runtime._createHUDController());
      // point the HUD's controller object at the runtime for push paths
      runtime.hud = hud;

      // Real driver loop self-stops → runtime.handleError → witness push.
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 700));

      const problem = view.calls.problems.at(-1);
      assert.ok(problem, "HUD should have received a problem from the real self-stop");
      assert.equal(problem.label, "Board lost:");
      assert.ok(
        view.calls.runControls.at(-1).autoSolveLabel === "▶️ Auto-solve",
        "run toggle must show stopped after a real driver self-stop"
      );
      assert.equal(runtime.getStats().isRunning, true); // the stale flag, still

      runtime.stop();
      hud.destroy();
    } finally {
      dom.remove();
    }
  });

  test("solver fallback via the real manager renders the verbatim reason", async () => {
    const dom = installDomShim();
    try {
      const hud = new HUD();
      const view = makeFakeView();
      hud.view = view;

      const manager = createSolverManager({
        moduleUrl: pathToFileURL("/nonexistent/playkit-solver.mjs").href,
        wasmUrl: pathToFileURL("/nonexistent/playkit-solver.wasm").href,
      });
      await manager.initialize();
      hud.updateSolverStatus(manager.getStatus());

      const shown = view.calls.solver.at(-1);
      assert.equal(shown.text, "Fallback");
      assert.ok(shown.title.includes(String(manager.getStatus().lastError)));
      hud.destroy();
    } finally {
      dom.remove();
    }
  });
});
