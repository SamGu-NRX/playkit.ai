/**
 * Witness tests for the HUD control-state model.
 *
 * Every test drives `reduceControlState` with witnesses that mirror real
 * runtime surfaces (getStats shapes, driver callbacks, command results) and
 * asserts the resulting state. Run: `node --test src/hud/`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE,
  SOLVER_STATE,
  COMMAND,
  RETRY_LIMIT,
  createInitialControlState,
  reduceControlState,
  deriveSolverState,
  deriveRetryAvailable,
  deriveProblem,
  headlineSignals,
  describePhase,
  describeSolver,
} from "../src/hud/control-state.js";

// --- helpers -------------------------------------------------------------
// These factories mirror the REAL runtime shapes (Runtime.getStats,
// driverStats as emitted by the driver, SolverManager.getStatus) so the tests
// double as a contract pin for the runtime surfaces the HUD consumes.

const stats = (over = {}) => ({
  isInitialized: true,
  isRunning: false,
  adapterName: null,
  driverStats: null,
  solver: null,
  ...over,
});

const driving = (over = {}) => ({
  isRunning: true,
  isPaused: false,
  moveCount: 0,
  stopReason: null,
  ...over,
});

const solverStatus = (over = {}) => ({
  status: "idle",
  mode: "js",
  wasm: null,
  lastError: null,
  ...over,
});

function reduced(witnesses, init) {
  return witnesses.reduce(
    (s, w) => reduceControlState(s, w),
    init ?? createInitialControlState()
  );
}

const cmd = (command, ok, extra = {}) => ({
  type: "command-result",
  command,
  ok,
  error: null,
  stats: null,
  ...extra,
});

// --- initial state -------------------------------------------------------
test("initial state claims nothing: no board, not playing, no run, unknown solver", () => {
  const s = createInitialControlState();
  assert.equal(s.phase, PHASE.NO_BOARD);
  assert.equal(s.board.name, null);
  assert.equal(s.run.started, false);
  assert.equal(s.run.endedBy, null);
  assert.equal(s.run.moveCount, null);
  assert.equal(s.solver.state, SOLVER_STATE.UNKNOWN);
  assert.equal(s.problem, null);
  assert.equal(s.retry.available, false);
  assert.deepEqual(headlineSignals(s), {
    foundBoard: false,
    playing: false,
    fallenBack: false,
    stopped: false,
  });
});

// --- solver channel ------------------------------------------------------
test("solver: wasm-ready status yields WASM state, no advisory", () => {
  const s = deriveSolverState(
    solverStatus({ status: "ready", mode: "wasm", wasm: {} })
  );
  assert.equal(s.state, SOLVER_STATE.WASM);
  assert.equal(s.attemptedWasm, true);
  assert.equal(s.advisory, null);
});

test("solver: fallback with attempted WASM yields advisory carrying the verbatim reason", () => {
  const reason = "WebAssembly.instantiate failed: bad magic";
  const s = deriveSolverState(
    solverStatus({ status: "ready", mode: "js", wasm: {}, lastError: reason })
  );
  assert.equal(s.state, SOLVER_STATE.FALLBACK);
  assert.equal(s.reason, reason); // verbatim, never paraphrased
  assert.equal(s.advisory.kind, "wasm-unavailable");
  assert.ok(s.advisory.message.includes(reason));
  assert.equal(s.advisory.nextAction.kind, "reload");
});

test("solver: fallback with no WASM engine attempted is a config fact, not a failure", () => {
  const s = deriveSolverState(solverStatus({ status: "ready", mode: "js", wasm: null }));
  assert.equal(s.state, SOLVER_STATE.FALLBACK);
  assert.equal(s.attemptedWasm, false);
  assert.equal(s.advisory, null);
});

test("solver: error state surfaces the manager's own lastError verbatim", () => {
  const s = deriveSolverState(solverStatus({ status: "error", lastError: "boom" }));
  assert.equal(s.state, SOLVER_STATE.ERROR);
  assert.equal(s.reason, "boom");
});

test("solver: null status is unknown, never guessed", () => {
  assert.equal(deriveSolverState(null).state, SOLVER_STATE.UNKNOWN);
});

// --- snapshot: board and phase facts -------------------------------------
test("snapshot with a detected board and idle driver: READY, foundBoard true", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048" }) },
  ]);
  assert.equal(s.phase, PHASE.READY);
  assert.equal(s.board.name, "2048");
  assert.equal(headlineSignals(s).foundBoard, true);
  assert.equal(headlineSignals(s).playing, false);
});

test("snapshot with driver running: PLAYING; with paused: PAUSED", () => {
  const playing = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
  ]);
  assert.equal(playing.phase, PHASE.PLAYING);
  assert.equal(playing.run.started, true);

  const paused = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isPaused: true, moveCount: 7 }) }) },
  ]);
  assert.equal(paused.phase, PHASE.PAUSED);
  assert.equal(paused.run.moveCount, 7);
});

test("driver self-stop: driverStats outrank the (stale) runtime isRunning flag", () => {
  // The real runtime can leave isRunning stale after a driver self-stop;
  // driverStats.isRunning=false + stopReason is the truth.
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", isRunning: true, driverStats: driving({ isRunning: false, stopReason: "No board progress for 30s" }) }) },
  ]);
  assert.equal(s.phase, PHASE.STOPPED);
  assert.equal(s.run.endedBy, "driver");
  assert.equal(s.run.reason, "No board progress for 30s"); // verbatim
  assert.equal(s.problem.kind, "stalled");
  assert.equal(s.problem.nextAction.kind, "retry");
  assert.equal(s.retry.available, true);
});

test("board-lost stop reason maps to a board-lost problem with a detect action", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }) },
  ]);
  assert.equal(s.phase, PHASE.STOPPED);
  assert.equal(s.problem.kind, "board-lost");
  assert.equal(s.problem.nextAction.kind, "detect");
});

test("run.moveCount carries through later snapshots that omit driverStats", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ moveCount: 42 }) }) },
    { type: "snapshot", stats: stats({ adapterName: "2048" }) }, // transient shape
  ]);
  assert.equal(s.run.moveCount, 42); // measured fact, not reset to zero
});

// --- run-state channel ---------------------------------------------------
test("run-state(true) is a fact of a running run even before a board name is witnessed", () => {
  const s = reduced([{ type: "run-state", isRunning: true }]);
  assert.equal(s.phase, PHASE.PLAYING);
  assert.equal(s.run.started, true);
  assert.equal(s.board.name, null); // unknown ≠ fabricated
});

test("run-state(false) while playing records a runtime-attributed stop, no invented problem", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
    { type: "run-state", isRunning: false },
  ]);
  assert.equal(s.phase, PHASE.STOPPED);
  assert.equal(s.run.endedBy, "runtime");
  assert.equal(s.run.reason, null);
  assert.equal(s.problem, null); // a clean stop is not an error
});

test("run-state witnesses cannot clobber a driver-attributed stop", () => {
  const stopped = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "No board progress for 30s" }) }) },
    { type: "run-state", isRunning: false },
  ]);
  assert.equal(stopped.run.endedBy, "driver"); // driver fact survives
  assert.equal(stopped.run.reason, "No board progress for 30s");
});

// --- command results -----------------------------------------------------
test("start ok (with post-command snapshot) is playing; user stop records endedBy user", () => {
  const started = reduced([
    cmd(COMMAND.START, true, { stats: stats({ adapterName: "2048", driverStats: driving() }) }),
  ]);
  assert.equal(started.phase, PHASE.PLAYING);
  assert.equal(started.run.endedBy, null);
  assert.equal(started.problem, null);

  const stopped = reduceControlState(started, cmd(COMMAND.STOP, true));
  assert.equal(stopped.phase, PHASE.STOPPED);
  assert.equal(stopped.run.endedBy, "user");
  assert.equal(stopped.problem, null);
  assert.equal(stopped.retry.available, true); // user stops are resumable
});

test("start ok cannot override a snapshot that already recorded a driver stop", () => {
  // start() succeeded but the run ended the instant it started (e.g. the
  // board died immediately). The snapshot's stop fact outranks the command.
  const s = reduced([
    cmd(COMMAND.START, true, {
      stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Game over - no moves" }) }),
    }),
  ]);
  assert.equal(s.phase, PHASE.STOPPED);
  assert.equal(s.run.endedBy, "game-over");
  assert.equal(s.problem.kind, "game-over");
});

test("start failure with the runtime's no-board error maps to a detect action", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048" }) },
    cmd(COMMAND.START, false, { error: new Error("No game detected on this page") }),
  ]);
  assert.equal(s.phase, PHASE.NO_BOARD);
  assert.equal(s.problem.kind, "no-board-at-start");
  assert.equal(s.problem.nextAction.kind, "detect");
});

test("start failure with 'not initialized' maps to a reload action", () => {
  const s = reduced([
    cmd(COMMAND.START, false, { error: new Error("Runtime is not initialized") }),
  ]);
  assert.equal(s.init.failed, true);
  assert.equal(s.problem.kind, "init-failed");
  assert.equal(s.problem.nextAction.kind, "reload");
  assert.equal(s.retry.available, false);
});

test("pause and resume flow through command results", () => {
  const playing = reduced([
    cmd(COMMAND.START, true, { stats: stats({ adapterName: "2048", driverStats: driving() }) }),
  ]);
  const paused = reduceControlState(playing, cmd(COMMAND.PAUSE, true, {
    stats: stats({ adapterName: "2048", driverStats: driving({ isPaused: true }) }),
  }));
  assert.equal(paused.phase, PHASE.PAUSED);

  const resumed = reduceControlState(paused, cmd(COMMAND.RESUME, true, {
    stats: stats({ adapterName: "2048", driverStats: driving() }),
  }));
  assert.equal(resumed.phase, PHASE.PLAYING);
  assert.equal(resumed.run.endedBy, null);
});

test("a failed stop command does not invent a state change (transient toast)", () => {
  const playing = reduced([
    cmd(COMMAND.START, true, { stats: stats({ adapterName: "2048", driverStats: driving() }) }),
  ]);
  const after = reduceControlState(playing, cmd(COMMAND.STOP, false, {
    error: new Error("driver busy"),
  }));
  assert.equal(after.phase, PHASE.PLAYING); // facts unchanged
  assert.equal(after.run.endedBy, null);
});

// --- retry lifecycle -----------------------------------------------------
test("retry failures accumulate and exhaust at the limit, then retry is unavailable", () => {
  let s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "No board progress for 30s" }) }) },
  ]);
  for (let i = 0; i < RETRY_LIMIT; i++) {
    s = reduceControlState(s, cmd(COMMAND.RETRY, false, { error: new Error("No game detected on this page") }));
  }
  assert.equal(s.retry.used, RETRY_LIMIT);
  assert.equal(s.retry.exhausted, true);
  assert.equal(s.retry.available, false);
  assert.equal(s.problem.kind, "retry-exhausted");
  assert.equal(s.problem.nextAction.kind, "reload");
  assert.match(s.problem.message, /2 attempts/);
});

test("a successful retry resets the failure counter and clears the problem", () => {
  let s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "No board progress for 30s" }) }) },
    cmd(COMMAND.RETRY, false),
  ]);
  assert.equal(s.problem.kind, "stalled");

  s = reduceControlState(s, cmd(COMMAND.RETRY, true));
  assert.equal(s.retry.used, 0);
  assert.equal(s.problem, null);
});

// --- game over -----------------------------------------------------------
test("game-over witness ends the run with the driver's own reason and no retry", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
    { type: "game-over", reason: "Game over - victory", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false }) }) },
  ]);
  assert.equal(s.phase, PHASE.STOPPED);
  assert.equal(s.run.endedBy, "game-over");
  assert.equal(s.run.reason, "Game over - victory"); // verbatim driver reason
  assert.equal(s.problem.kind, "game-over");
  assert.equal(s.retry.available, false); // a dead board stays dead
});

test("re-detecting the board after a game over does not resurrect playability", () => {
  let s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
    { type: "game-over", reason: "Game over - victory" },
  ]);
  s = reduceControlState(s, cmd(COMMAND.DETECT, true, {
    stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Game over - victory" }) }),
  }));
  assert.equal(s.problem.kind, "game-over"); // still over
  assert.equal(s.retry.available, false);
});

// --- problem lifecycle ---------------------------------------------------
test("a successful re-detect clears a board-lost problem instead of resurrecting it", () => {
  let s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }) },
  ]);
  assert.equal(s.problem.kind, "board-lost");

  // Detection succeeds; the run is still over, but the board is back.
  s = reduceControlState(s, cmd(COMMAND.DETECT, true, {
    stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }),
  }));
  assert.equal(s.phase, PHASE.STOPPED); // the run itself did not restart
  assert.equal(s.problem, null); // cause resolved, banner gone
  assert.equal(s.retry.available, true); // driver-ended with a live board
});

test("an unrelated later snapshot does not resurrect a cleared problem", () => {
  let s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }) },
  ]);
  s = reduceControlState(s, cmd(COMMAND.DETECT, true, {
    stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }),
  }));
  s = reduceControlState(s, { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving({ isRunning: false, stopReason: "Abandoned after failed board reads" }) }) });
  assert.equal(s.problem, null);
});

test("starting a run clears any standing problem", () => {
  let s = reduced([
    cmd(COMMAND.START, false, { error: new Error("No game detected on this page") }),
  ]);
  assert.equal(s.problem.kind, "no-board-at-start");
  s = reduced([cmd(COMMAND.START, true, { stats: stats({ adapterName: "2048", driverStats: driving() }) })], s);
  assert.equal(s.problem, null);
});

// --- solver-status channel ----------------------------------------------
test("solver-status updates only the solver channel; phase and board stand", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
    { type: "solver-status", status: solverStatus({ status: "ready", mode: "js", wasm: {}, lastError: "compile error: oob" }) },
  ]);
  assert.equal(s.phase, PHASE.PLAYING);
  assert.equal(s.solver.state, SOLVER_STATE.FALLBACK);
  assert.equal(s.solver.reason, "compile error: oob");
  assert.equal(headlineSignals(s).fallenBack, true);
});

// --- init / reset --------------------------------------------------------
test("init-failed witness claims no board and points at reload", () => {
  const s = reduced([{ type: "init-failed", message: "Solver unavailable" }]);
  assert.equal(s.phase, PHASE.NO_BOARD);
  assert.equal(s.board.name, null);
  assert.equal(s.problem.kind, "init-failed");
  assert.ok(s.problem.message.includes("Solver unavailable"));
});

test("reset returns to a fully unclaimed initial state", () => {
  const s = reduced([
    { type: "snapshot", stats: stats({ adapterName: "2048", driverStats: driving() }) },
    { type: "reset" },
  ]);
  assert.deepEqual(s, createInitialControlState());
});

// --- misc ----------------------------------------------------------------
test("unknown witness types leave state untouched; reduce never mutates its input", () => {
  const before = createInitialControlState();
  const frozen = { ...before };
  const after = reduceControlState(before, { type: "something-else" });
  assert.deepEqual(before, frozen);
  assert.equal(after, before);
});

test("describePhase/describeSolver never invent rationale", () => {
  assert.equal(describePhase(PHASE.NO_BOARD), "No board found");
  assert.equal(describePhase(PHASE.PLAYING), "Playing");
  const d = describeSolver({ state: SOLVER_STATE.FALLBACK, reason: "x" });
  assert.ok(d.title.includes("x"));
  assert.equal(describeSolver({ state: SOLVER_STATE.UNKNOWN, reason: null }).label, "—");
});

test("deriveProblem returns null for clean user/runtime stops", () => {
  assert.equal(deriveProblem({ endedBy: "user", reason: null }, null, { exhausted: false, used: 0 }), null);
  assert.equal(deriveProblem({ endedBy: "runtime", reason: null }, null, { exhausted: false, used: 0 }), null);
});
