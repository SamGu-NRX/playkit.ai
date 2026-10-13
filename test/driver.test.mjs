/**
 * Zero-dependency node:test suite for src/driver/driver.js.
 * No fake timers: short real tick intervals via throttleMs/domChangeTimeoutMs.
 *
 * Active tests pin the driver's CURRENT behavior (including buggy behaviors
 * being fixed on the integration branch). Known-bug target behavior is
 * encoded as test.skip cases marked TODO(FIX-n):
 *
 *   FIX-2: a solver returning [] (no valid moves = game over) is currently
 *          padded to all four directions by normalizeMovePriority and pressed
 *          forever. Target: onGameOver fires, driver stops, zero presses.
 *   FIX-5: options.maxRetries is stored in config but never read anywhere.
 *          Target: after maxRetries consecutive failed reads, stop + onError
 *          exactly once, zero further presses.
 *   FIX-5b: failed reads must never cause sendMove calls even before
 *           maxRetries is exhausted. (Already holds today — pinned by active
 *           tests below; the skipped target test documents the contract.)
 *
 * Run: node --test test/driver.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { Driver } from "../src/driver/driver.js";
import { installDomShim } from "./helpers/dom-shim.mjs";
import { isValidMove, simulateMove } from "./helpers/reference-2048.mjs";

// Direction convention: 0=Up, 1=Right, 2=Down, 3=Left.
const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

// Short real-timer pacing: one loop period is ~throttleMs + domChangeTimeoutMs.
const TIMING = { throttleMs: 20, domChangeTimeoutMs: 10 };
const CYCLE_MS = TIMING.throttleMs + TIMING.domChangeTimeoutMs;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition with real timers; resolves true when met, else false on timeout. */
async function waitFor(condition, timeoutMs = 3000, stepMs = 2) {
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

/**
 * Fake adapter double. `onSend(dir, board)` returns the next board or null
 * for a no-op press. `failReads` simulates readBoard failures ('null' | 'throw').
 */
class FakeAdapter {
  constructor({ board = START_BOARD, onSend, failReads = null, gameOver = false } = {}) {
    this.board = board.map((row) => row.slice());
    this.onSend =
      onSend ??
      ((dir, board) => (isValidMove(board, dir) ? simulateMove(board, dir) : null));
    this.failReads = failReads;
    this.gameOver = gameOver;
    this.reads = 0;
    this.sent = [];
  }
  readBoard() {
    this.reads += 1;
    if (this.failReads === "throw") throw new Error("read failed");
    if (this.failReads === "null") return null;
    return this.board.map((row) => row.slice());
  }
  sendMove(dir) {
    this.sent.push(dir);
    const next = this.onSend(dir, this.board);
    if (next) this.board = next;
  }
  isGameOver() {
    return this.gameOver;
  }
  getScore() {
    return 0;
  }
  getName() {
    return "FakeAdapter";
  }
  canAttach() {
    return true;
  }
}

/** Fake solver engine: getMoveOrder(board) -> ordered directions. */
class FakeSolver {
  constructor(orderFn) {
    this.orderFn = orderFn;
    this.calls = [];
  }
  async getMoveOrder(board) {
    this.calls.push(board);
    return this.orderFn(board);
  }
}

/** Recorder for driver callbacks: calls[i] is the args array of invocation i. */
function recorder() {
  const calls = [];
  const fn = (...args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

function makeDriver(options = {}) {
  return new Driver({ ...TIMING, ...options });
}

describe("Driver", () => {
  let shim;
  beforeEach(() => {
    shim = installDomShim();
  });
  afterEach(() => {
    shim.remove();
  });

  describe("construction and lifecycle", () => {
    test("constructor registers exactly one visibilitychange listener and nothing else", () => {
      const driver = makeDriver();
      assert.equal(shim.listeners.length, 1);
      assert.equal(shim.listeners[0].type, "visibilitychange");
      assert.equal(shim.listeners[0].listener, driver.handleVisibilityChange);
    });

    test("constructor stores config with documented defaults; maxRetries is stored but never read (FIX-5)", () => {
      const driver = new Driver(); // no options -> true defaults
      assert.equal(driver.config.throttleMs, 130);
      assert.equal(driver.config.domChangeTimeoutMs, 120);
      assert.equal(driver.config.pauseWhenHidden, true);
      assert.equal(driver.config.maxRetries, 3); // stored...
      assert.equal(driver.config.stuckThreshold, 5);
      assert.deepEqual(driver.directionPriority, [LEFT, DOWN, RIGHT, UP]);
    });

    test("start() without an adapter throws and does not start", () => {
      const driver = makeDriver();
      assert.throws(() => driver.start(), /No adapter set/);
      assert.equal(driver.isRunning, false);
    });

    test("destroy() removes the visibilitychange listener and clears collaborators", () => {
      const driver = makeDriver();
      driver.setAdapter(new FakeAdapter());
      driver.onMove = recorder();
      driver.destroy();
      assert.equal(shim.listeners.length, 0);
      assert.equal(driver.adapter, null);
      assert.equal(driver.solverEngine, null);
      assert.equal(driver.onMove, null);
      assert.equal(driver.onGameOver, null);
      assert.equal(driver.onError, null);
    });

    test("start() begins ticking: reads and presses advance", async () => {
      const adapter = new FakeAdapter();
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.start();
      try {
        assert.ok(await waitFor(() => adapter.reads >= 4), "driver did not tick");
        assert.equal(driver.isRunning, true);
        assert.ok(adapter.sent.length >= 1, "driver did not press any key");
      } finally {
        driver.stop();
      }
    });

    test("documents current behavior: calling start() twice is a no-op (state preserved, single loop)", async () => {
      const adapter = new FakeAdapter();
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.start();
      try {
        // moveCount increments only after a press is VERIFIED (dom wait + re-read),
        // so waiting on it avoids sampling mid-move.
        assert.ok(await waitFor(() => driver.moveCount >= 1), "no completed move");
        assert.equal(driver.moveCount, 1);

        driver.start(); // guarded: isRunning -> warn + return (no reset(), no second loop)
        assert.equal(driver.moveCount, 1, "second start() must not reset state");
        assert.equal(driver.isRunning, true);
        assert.ok(await waitFor(() => driver.moveCount >= 2), "loop stopped after second start()");
      } finally {
        driver.stop();
      }
    });

    test("stop() halts the loop: no reads or presses within 3 loop periods after in-flight tick drains", async () => {
      const adapter = new FakeAdapter();
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.start();
      try {
        assert.ok(await waitFor(() => adapter.sent.length >= 2));
        driver.stop();
        assert.equal(driver.isRunning, false);

        await sleep(TIMING.domChangeTimeoutMs * 4); // let any in-flight tick finish
        const readsAtStop = adapter.reads;
        const sentAtStop = adapter.sent.length;
        await sleep(CYCLE_MS * 3 + 100);
        assert.equal(adapter.reads, readsAtStop, "reads advanced after stop()");
        assert.equal(adapter.sent.length, sentAtStop, "presses advanced after stop()");
      } finally {
        driver.stop();
      }
    });
  });

  describe("no-op safety (stuck handling)", () => {
    test("documents current behavior: solver order is padded to all four directions per tick; stuck counter triggers executeRandomMove; driver never stops", async () => {
      const noopAdapter = new FakeAdapter({ onSend: () => null }); // board never changes
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver({ stuckThreshold: 2 });
      driver.setAdapter(noopAdapter);
      driver.setSolverEngine(solver);
      driver.onGameOver = recorder();
      driver.start();
      try {
        // Tick 1: solver said [LEFT] only, but executeMove presses 3,2,1,0 (padded order).
        assert.ok(await waitFor(() => noopAdapter.sent.length >= 4));
        assert.deepEqual(noopAdapter.sent.slice(0, 4), [LEFT, DOWN, RIGHT, UP]);

        // Tick 2 (stuck=2 >= threshold): executeRandomMove adds exactly one more press.
        assert.ok(await waitFor(() => noopAdapter.sent.length >= 9));
        const snapshot = noopAdapter.sent.length;
        assert.notEqual(snapshot % 4, 0, "expected a non-executeMove press (random move)");
        assert.equal(driver.isRunning, true, "driver must keep running on a no-op game");
        assert.deepEqual(driver.onGameOver.calls, [], "no game over on a merely stuck game");
      } finally {
        driver.stop();
      }
    });
  });

  describe("single successful move", () => {
    test("successful first direction presses exactly once: no fallback directions sent in the same executeMove", async () => {
      const adapter = new FakeAdapter(); // responds to any valid move
      const solver = new FakeSolver(() => [LEFT]);
      const onMove = recorder();
      const onBoardChange = recorder();
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onMove = onMove;
      driver.onBoardChange = onBoardChange;

      const success = await driver.step(); // one executeMove, no loop

      assert.equal(success, true);
      assert.deepEqual(adapter.sent, [LEFT]); // exactly one press, no fallbacks
      assert.deepEqual(onMove.calls, [[LEFT, 1]]);
      assert.equal(onBoardChange.calls.length, 1);
      assert.deepEqual(onBoardChange.calls[0][0], simulateMove(START_BOARD, LEFT));
    });
  });

  describe("callbacks", () => {
    test("onError fires with the solver error and the driver falls back to directionPriority", async () => {
      const adapter = new FakeAdapter(); // LEFT (fallback priority[0]) still succeeds
      const solver = new FakeSolver(() => {
        throw new Error("solver exploded");
      });
      const onError = recorder();
      const onMove = recorder();
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onError = onError;
      driver.onMove = onMove;

      const success = await driver.step();

      assert.equal(success, true);
      assert.equal(onError.calls.length, 1);
      assert.ok(onError.calls[0][0] instanceof Error);
      assert.match(onError.calls[0][0].message, /solver exploded/);
      assert.deepEqual(adapter.sent, [LEFT]); // fallback priority tries LEFT first
      assert.deepEqual(onMove.calls, [[LEFT, 1]]);
    });

    test("adapter.isGameOver() => onGameOver fires with no args, driver stops, zero reads and zero presses", async () => {
      const adapter = new FakeAdapter({ gameOver: true });
      const solver = new FakeSolver(() => [LEFT]);
      const onGameOver = recorder();
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onGameOver = onGameOver;
      driver.start();
      try {
        assert.ok(await waitFor(() => onGameOver.calls.length >= 1));
        assert.deepEqual(onGameOver.calls, [[]]); // one call, no arguments
        assert.equal(driver.isRunning, false);
        assert.equal(adapter.reads, 0, "game-over check happens before readBoard");
        assert.equal(adapter.sent.length, 0);
        await sleep(CYCLE_MS * 2);
        assert.equal(adapter.sent.length, 0, "no presses after game over");
      } finally {
        driver.stop();
      }
    });
  });

  describe("visibility (pauseWhenHidden)", () => {
    test("ticks do not execute moves while hidden and resume when visible", async () => {
      const adapter = new FakeAdapter();
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver(); // pauseWhenHidden defaults to true
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.start();
      try {
        assert.ok(await waitFor(() => adapter.sent.length >= 2));

        shim.setHidden(true); // fires visibilitychange: handleVisibilityChange -> pause()
        await sleep(TIMING.domChangeTimeoutMs * 4); // drain in-flight tick
        const sentWhileHidden = adapter.sent.length;
        await sleep(300); // > the 250ms hidden re-arm period
        assert.equal(adapter.sent.length, sentWhileHidden, "driver pressed while hidden");
        assert.equal(driver.isPaused, true);

        shim.setHidden(false); // fires visibilitychange: resume -> tick()
        assert.ok(await waitFor(() => adapter.sent.length > sentWhileHidden));
        assert.equal(driver.isPaused, false);
      } finally {
        driver.stop();
      }
    });
  });

  describe("failed reads (FIX-5 implemented on the hardening branch)", () => {
    test("FIX-5: readBoard returning null never presses and the driver stops after maxRetries with exactly one onError", async () => {
      const adapter = new FakeAdapter({ failReads: "null" });
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver({ stuckThreshold: 2, maxRetries: 2 });
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onError = recorder();
      driver.onGameOver = recorder();
      driver.start();
      try {
        assert.ok(await waitFor(() => driver.onError.calls.length >= 1), "driver never surfaced the failed reads");
        assert.equal(driver.isRunning, false, "driver must stop after maxRetries failed reads");
        assert.equal(adapter.reads, 2, "driver must stop after exactly maxRetries failed reads");
        assert.equal(adapter.sent.length, 0, "driver pressed despite failed reads");
        assert.equal(driver.onError.calls.length, 1, "onError must fire exactly once");
        assert.equal(driver.onGameOver.calls.length, 0, "failed reads are not game over");
      } finally {
        driver.stop();
      }
    });

    // Throwing reads surface onError per tick and the loop continues — now
    // bounded by maxNoProgressTicks (20 by default), after which the driver
    // stops with a "no board progress (last: tick error)" reason.
    test("documents throwing reads: onError on every tick, never presses, loop continues (bounded)", async () => {
      const adapter = new FakeAdapter({ failReads: "throw" });
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver({ maxRetries: 2 });
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onError = recorder();
      driver.start();
      try {
        assert.ok(await waitFor(() => driver.onError.calls.length >= 2));
        assert.equal(driver.isRunning, true, "driver keeps looping after read errors");
        assert.equal(adapter.sent.length, 0, "driver pressed despite throwing reads");
        assert.ok(adapter.reads >= 2, "read attempts happened (and threw) each tick");
      } finally {
        driver.stop();
      }
    });
  });

  describe("known bugs — target behavior (skipped until integration fixes land)", () => {
    // FIX-2 (implemented on the hardening branch): an empty solver order is
    // treated as game over — onGameOver fires, driver stops, zero presses.
    test("solver returning [] => onGameOver fires, driver stops, zero sendMove calls", async () => {
      const adapter = new FakeAdapter(); // board still moveable — the solver is the game-over signal
      const solver = new FakeSolver(() => []);
      const onGameOver = recorder();
      const driver = makeDriver();
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onGameOver = onGameOver;
      driver.start();

      assert.ok(await waitFor(() => onGameOver.calls.length >= 1), "onGameOver never fired");
      assert.equal(adapter.sent.length, 0, "driver pressed keys on a dead game");
      assert.equal(driver.isRunning, false, "driver did not stop on game over");
    });

    // FIX-5 (implemented on the hardening branch): config.maxRetries is live —
    // stop + onError exactly once after maxRetries consecutive failed reads.
    test("after maxRetries consecutive failed reads, driver stops and fires onError exactly once, zero further sendMove calls", async () => {
      const adapter = new FakeAdapter({ failReads: "null" });
      const solver = new FakeSolver(() => [LEFT]);
      const onError = recorder();
      const driver = makeDriver({ maxRetries: 2 });
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.onError = onError;
      driver.start();

      assert.ok(await waitFor(() => adapter.reads >= 2), "driver did not reach maxRetries reads");
      assert.ok(await waitFor(() => onError.calls.length >= 1), "onError never fired");
      await sleep(CYCLE_MS * 2);
      assert.equal(onError.calls.length, 1, "onError must fire exactly once");
      assert.equal(adapter.sent.length, 0, "driver pressed keys on failed reads");
      assert.equal(driver.isRunning, false, "driver did not stop after maxRetries");
    });

    // FIX-5b (contract pin): failed reads never press keys, even before
    // maxRetries is exhausted (random escapes bail before sending too).
    test("failed reads never cause sendMove calls even before maxRetries is exhausted", async () => {
      const adapter = new FakeAdapter({ failReads: "null" });
      const solver = new FakeSolver(() => [LEFT]);
      const driver = makeDriver({ maxRetries: 10, stuckThreshold: 1 });
      driver.setAdapter(adapter);
      driver.setSolverEngine(solver);
      driver.start();

      assert.ok(await waitFor(() => adapter.reads >= 3));
      assert.equal(adapter.sent.length, 0, "driver pressed keys before maxRetries was exhausted");
      driver.stop();
    });
  });
});
