/**
 * Real-runtime fixture tests for the HUD control-state model.
 *
 * These tests boot the REAL Runtime (src/runtime/runtime.js) with its REAL
 * Driver and REAL SolverManager under the DOM shim, drive real stop paths
 * (game over, no-progress self-stop, failed board reads, user stop/pause),
 * and record each `runtime.getStats()` snapshot. Every recorded snapshot is
 * (a) pinned as the runtime→HUD witness contract and (b) fed through
 * `reduceControlState` to assert the state model resolves it correctly —
 * including the stale-runtime-flag cases this control console exists to fix.
 *
 * No fake timers: real driver loops with retuned (short) intervals.
 * Run: node --test test/hud-runtime-fixtures.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { Runtime } from "../src/runtime/runtime.js";
import { createSolverManager } from "../src/solver/solver-manager.js";
import { installDomShim } from "./helpers/dom-shim.mjs";
import { isValidMove, simulateMove } from "./helpers/reference-2048.mjs";
import {
  createInitialControlState,
  reduceControlState,
  PHASE,
  SOLVER_STATE,
} from "../src/hud/control-state.js";

// Short real-timer pacing for the real driver loops.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs = 4000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

// A board where LEFT is a valid (changing) move.
const START_BOARD = [
  [2, 2, 0, 0],
  [4, 0, 0, 0],
  [2, 0, 0, 0],
  [0, 0, 2, 2],
];

// A board where every move is blocked: the real driver can make no progress.
const BLOCKED_BOARD = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
];

/**
 * Fake adapter double implementing the adapter contract the real Driver
 * consumes (readBoard/sendMove/isGameOver/getName/getScore).
 */
class FakeAdapter {
  constructor({ board = START_BOARD, onSend, failReads = null, gameOver = false } = {}) {
    this.board = board.map((row) => row.slice());
    this.onSend =
      onSend ??
      ((dir, board) => (isValidMove(board, dir) ? simulateMove(board, dir) : null));
    this.failReads = failReads;
    this.gameOver = gameOver;
    this.movePresses = 0;
  }
  getName() {
    return "Fixture 2048";
  }
  getScore() {
    return 12;
  }
  isGameOver() {
    return this.gameOver;
  }
  readBoard() {
    if (this.failReads === "null") return null;
    if (this.failReads === "throw") throw new Error("read failed");
    return this.board.map((row) => row.slice());
  }
  sendMove(dir) {
    this.movePresses++;
    const next = this.onSend(dir, this.board);
    if (next) this.board = next.map((row) => row.slice());
  }
}

/**
 * Boot the real Runtime without a browser: HUD, visibility handling, and
 * mutation observer are disabled (they need DOM), while driver, solver
 * manager, and all runtime bookkeeping are the real implementations.
 * The adapter is attached directly (Runtime.init would run DOM detection).
 */
function bootRuntime(adapterOver = {}, driverOver = {}) {
  const dom = installDomShim();
  const runtime = new Runtime({
    autoInit: false,
    enableHUD: false,
    enableVisibilityHandling: false,
    enableMutationObserver: false,
    solver: { disableWasm: true },
  });
  runtime.isInitialized = true;
  const adapter = new FakeAdapter(adapterOver);
  runtime.currentAdapter = adapter;
  runtime.setupComponents();

  // Retune the REAL driver for test speed.
  runtime.driver.config.throttleMs = 15;
  runtime.driver.config.domChangeTimeoutMs = 10;
  runtime.driver.config.maxNoProgressTicks = 2;
  for (const [key, value] of Object.entries(driverOver)) {
    runtime.driver.config[key] = value;
  }

  return { runtime, adapter, dom };
}

describe("real-runtime HUD witness fixtures", () => {
  let dom;
  let runtime;
  let adapter;

  afterEach(() => {
    try {
      runtime?.stop?.();
    } catch {
      /* the fixture may already have stopped it */
    }
    dom.remove();
  });

  test("fixture: idle board — real getStats → READY with the detected board name", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    const recorded = runtime.getStats();
    // Pin the real witness shape.
    assert.equal(recorded.adapterName, "Fixture 2048");
    assert.equal(recorded.isInitialized, true);
    assert.equal(recorded.isRunning, false);
    assert.equal(recorded.driverStats.isRunning, false);
    assert.equal(recorded.driverStats.stopReason, null);

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.phase, PHASE.READY);
    assert.equal(state.board.name, "Fixture 2048");
    assert.equal(state.problem, null);
  });

  test("fixture: real driving loop — real getStats → PLAYING with measured moveCount", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    runtime.start();
    const moved = await waitFor(() => runtime.driver.getStats().moveCount > 0);
    assert.equal(moved, true, "real driver should complete a move");

    const recorded = runtime.getStats();
    assert.equal(recorded.isRunning, true);
    assert.equal(recorded.driverStats.isRunning, true);
    assert.equal(recorded.driverStats.isPaused, false);

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.phase, PHASE.PLAYING);
    assert.equal(state.run.started, true);
    assert.equal(state.run.moveCount, recorded.driverStats.moveCount);
    assert.equal(state.run.moveCount >= 1, true);
  });

  test("fixture: real pause — runtime flag false, driver paused; model says PAUSED", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    runtime.start();
    await waitFor(() => runtime.driver.getStats().moveCount > 0);
    runtime.pause();

    const recorded = runtime.getStats();
    // The REAL runtime flag goes false on pause while the driver keeps its
    // running state and isPaused=true — exactly the contradiction the model
    // resolves by driver-first precedence.
    assert.equal(recorded.isRunning, false);
    assert.equal(recorded.driverStats.isRunning, true);
    assert.equal(recorded.driverStats.isPaused, true);

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.phase, PHASE.PAUSED);
    assert.equal(state.run.started, true);

    runtime.resume();
    const resumed = reduceControlState(
      { ...state },
      { type: "snapshot", stats: runtime.getStats() }
    );
    assert.equal(resumed.phase, PHASE.PLAYING);
  });

  test("fixture: real user stop — endedBy user, retry offered", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    runtime.start();
    await waitFor(() => runtime.driver.getStats().moveCount > 0);
    runtime.stop();

    const recorded = runtime.getStats();
    assert.equal(recorded.driverStats.isRunning, false);
    assert.equal(recorded.driverStats.stopReason, null); // clean stop: no reason

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    const userStopped = reduceControlState(state, {
      type: "command-result",
      command: "stop",
      ok: true,
      error: null,
      stats: null,
    });
    assert.equal(userStopped.phase, PHASE.STOPPED);
    assert.equal(userStopped.run.endedBy, "user");
    assert.equal(userStopped.problem, null);
    assert.equal(userStopped.retry.available, true);
  });

  test("fixture: real game over — driver stops itself with 'game over', model blocks retry", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    runtime.start();
    await waitFor(() => runtime.driver.getStats().moveCount > 0);
    adapter.gameOver = true; // next real tick detects it and stops

    const stopped = await waitFor(() => runtime.driver.getStats().isRunning === false);
    assert.equal(stopped, true, "real driver should stop on game over");

    const recorded = runtime.getStats();
    // Runtime.handleGameOver ran the real stop path, so both flags are false.
    assert.equal(recorded.isRunning, false);
    assert.equal(recorded.driverStats.isRunning, false);
    assert.equal(recorded.driverStats.stopReason, "game over"); // verbatim

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.phase, PHASE.STOPPED);
    assert.equal(state.run.endedBy, "game-over");
    assert.equal(state.run.reason, "game over"); // verbatim, never paraphrased
    assert.equal(state.problem.kind, "game-over");
    assert.equal(state.retry.available, false);
  });

  test("fixture: real no-progress self-stop — runtime flag stays stale-true; model resolves STOPPED", async () => {
    ({ runtime, adapter, dom } = bootRuntime({
      board: BLOCKED_BOARD,
      onSend: () => null, // no move is valid: the real loop makes no progress
    }));

    runtime.start();
    const stopped = await waitFor(() => runtime.driver.getStats().isRunning === false);
    assert.equal(stopped, true, "bounded driver should give up after maxNoProgressTicks");

    const recorded = runtime.getStats();
    // THE staleness bug this console fixes: the driver stopped itself; the
    // runtime flag was never updated and still reads true.
    assert.equal(recorded.isRunning, true);
    assert.equal(recorded.driverStats.isRunning, false);
    assert.match(recorded.driverStats.stopReason, /^no board progress for 2 consecutive ticks$/);

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    // Driver facts outrank the stale runtime flag.
    assert.equal(state.phase, PHASE.STOPPED);
    assert.equal(state.run.endedBy, "driver");
    assert.equal(state.run.reason, "no board progress for 2 consecutive ticks");
    assert.equal(state.problem.kind, "stalled");
    assert.equal(state.problem.nextAction.kind, "retry");
    assert.equal(state.retry.available, true);
  });

  test("fixture: real failed-reads abandonment — model maps to board-lost + detect action", async () => {
    ({ runtime, adapter, dom } = bootRuntime({ failReads: "null" }, { maxNoProgressTicks: 50 }));

    runtime.start();
    const stopped = await waitFor(() => runtime.driver.getStats().isRunning === false);
    assert.equal(stopped, true, "bounded driver should abandon after maxRetries failed reads");

    const recorded = runtime.getStats();
    assert.equal(recorded.isRunning, true); // stale again: runtime never told
    assert.equal(recorded.driverStats.isRunning, false);
    assert.match(
      recorded.driverStats.stopReason,
      /^abandoned after 3 consecutive failed board reads$/
    );

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.phase, PHASE.STOPPED);
    assert.equal(state.problem.kind, "board-lost");
    assert.equal(state.problem.nextAction.kind, "detect");
    assert.equal(state.run.reason.includes("failed board reads"), true);
  });

  test("fixture: real solver fallback — missing WASM module yields verbatim lastError advisory", async () => {
    ({ runtime, adapter, dom } = bootRuntime());

    // Real SolverManager pointed at a module URL that cannot load — the
    // manager swallows the failure and serves the JS fallback.
    const manager = createSolverManager({
      moduleUrl: pathToFileURL("/nonexistent/playkit-solver.mjs").href,
      wasmUrl: pathToFileURL("/nonexistent/playkit-solver.wasm").href,
    });
    await manager.initialize();
    runtime.solverManager = manager;
    runtime.driver.setSolverEngine(manager);

    const recorded = runtime.getStats();
    // Pin the real solver status shape: after a failed WASM initialize the
    // REAL manager reports status "fallback" (not "ready"), mode "fallback",
    // and the swallowed error as lastError.
    assert.equal(recorded.solver.status, "fallback");
    assert.equal(recorded.solver.mode, "fallback");
    assert.equal(typeof recorded.solver.lastError, "string");
    assert.ok(recorded.solver.lastError.length > 0);

    const state = reduceControlState(createInitialControlState(), {
      type: "snapshot",
      stats: recorded,
    });
    assert.equal(state.solver.state, SOLVER_STATE.FALLBACK);
    assert.equal(state.solver.reason, recorded.solver.lastError); // verbatim
    assert.equal(state.solver.attemptedWasm, true);
    assert.equal(state.solver.advisory.kind, "wasm-unavailable");
    assert.ok(state.solver.advisory.message.includes(recorded.solver.lastError));
    assert.equal(headlineLike(state).fallenBack, true);
  });
});

function headlineLike(state) {
  // Local copy of headlineSignals to keep the import list focused; the model
  // test suite already pins headlineSignals itself.
  return {
    fallenBack: state.solver.state === SOLVER_STATE.FALLBACK,
  };
}
