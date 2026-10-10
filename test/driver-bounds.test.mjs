/**
 * Zero-dependency node:test suite for the driver's bounded-stop behavior.
 *
 * Pins the bench findings from the browser benchmark (bench/BASELINE.md):
 *  - gameover scenario: the driver pressed a dead board indefinitely
 *    (105 synthetic events in ~3 s, zero effect) — the loop is now bounded
 *    by maxNoProgressTicks and stops with a reason.
 *  - progress resets the bound; a healthy game is never stopped by it.
 *  - setAdapter/start reset the bound counters.
 *
 * Move legality on the "playing" board is validated against the independent
 * reference rules (test/helpers/reference-2048.mjs).
 *
 * Run: node --test test/driver-bounds.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { Driver } from "../src/driver/driver.js";
import { installDomShim } from "./helpers/dom-shim.mjs";
import { isValidMove, simulateMove } from "./helpers/reference-2048.mjs";

// Direction convention: 0=Up, 1=Right, 2=Down, 3=Left.
const UP = 0;
const LEFT = 3;

const TIMING = { throttleMs: 20, domChangeTimeoutMs: 10 };
const CYCLE_MS = TIMING.throttleMs + TIMING.domChangeTimeoutMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs = 3000, stepMs = 2) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(stepMs);
  }
  return condition();
}

/** A board where LEFT changes the board but gets stuck quickly. */
const START_BOARD = [
  [2, 2, 0, 0],
  [4, 0, 0, 0],
  [2, 0, 0, 0],
  [0, 0, 2, 2],
];

class FakeAdapter {
  constructor({ board = START_BOARD, failReads = false, moveForReal = false } = {}) {
    this.board = board.map((r) => [...r]);
    this.failReads = failReads;
    this.moveForReal = moveForReal;
    this.sent = [];
    this.reads = 0;
  }
  readBoard() {
    this.reads++;
    if (this.failReads) return null;
    return this.board.map((r) => [...r]);
  }
  sendMove(dir) {
    this.sent.push(dir);
    if (this.moveForReal && isValidMove(this.board, dir)) {
      // Reference rules: simulateMove returns the next board directly.
      this.board = simulateMove(this.board, dir);
    }
  }
  isGameOver() {
    return false;
  }
  getName() {
    return "FakeAdapter";
  }
}

describe("Driver bounded-stop behavior", () => {
  let shim;
  beforeEach(() => {
    shim = installDomShim();
  });
  afterEach(() => {
    shim.remove();
  });

  test("no-progress bound: driver stops with a reason and presses stop growing", async () => {
    // A board that never changes (all four directions are no-ops on it in
    // the driver's hash sense: readBoard always returns the same tiles).
    const adapter = new FakeAdapter({
      board: [
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, 2],
      ],
    });
    const onError = { calls: [] };
    const driver = new Driver({ ...TIMING, maxNoProgressTicks: 6 });
    driver.setAdapter(adapter);
    driver.onError = (e) => onError.calls.push(e);
    driver.start();

    assert.ok(await waitFor(() => !driver.isRunning, 5000), "driver never stopped");
    assert.match(driver.getStats().stopReason, /no board progress/);
    assert.equal(onError.calls.length, 1, "onError must fire exactly once");

    const sendsAtStop = adapter.sent.length;
    assert.ok(sendsAtStop > 0, "expected presses before the bound");
    await sleep(CYCLE_MS * 4);
    assert.equal(adapter.sent.length, sendsAtStop, "driver kept pressing after stop");
  });

  test("progress resets the no-progress bound: a healthy game keeps running", async () => {
    const adapter = new FakeAdapter({ moveForReal: true });
    const driver = new Driver({ ...TIMING, maxNoProgressTicks: 6 });
    driver.setAdapter(adapter);
    driver.start();

    assert.ok(await waitFor(() => driver.moveCount >= 8, 5000), "no completed moves");
    assert.equal(driver.isRunning, true, "healthy game was stopped by the bound");
    assert.equal(driver.getStats().noProgressCount, 0);
    assert.equal(driver.getStats().stopReason, null);
    driver.stop();
  });

  test("failed reads bound via maxRetries surface a stop reason", async () => {
    const adapter = new FakeAdapter({ failReads: true });
    const driver = new Driver({ ...TIMING, maxRetries: 3, maxNoProgressTicks: 50 });
    driver.setAdapter(adapter);
    driver.start();

    assert.ok(await waitFor(() => !driver.isRunning, 5000), "driver never stopped");
    assert.match(driver.getStats().stopReason, /failed board reads/);
    assert.equal(adapter.sent.length, 0, "driver pressed keys on failed reads");
  });

  test("setAdapter resets bound counters and stop reason", async () => {
    const driver = new Driver({ ...TIMING });
    driver.stopReason = "stale reason";
    driver.failedReads = 99;
    driver.noProgressCount = 99;

    driver.setAdapter(new FakeAdapter());

    const stats = driver.getStats();
    assert.equal(stats.stopReason, null);
    assert.equal(stats.failedReads, 0);
    assert.equal(stats.noProgressCount, 0);
  });

  test("playing board only ever receives reference-legal presses", async () => {
    const adapter = new FakeAdapter({ moveForReal: true });
    const driver = new Driver({ ...TIMING });
    driver.setAdapter(adapter);
    driver.start();

    assert.ok(await waitFor(() => driver.moveCount >= 5, 5000));
    // Let any in-flight tick land, then replay the presses actually sent
    // through the independent reference rules; the board the adapter
    // exposes must match exactly.
    await sleep(CYCLE_MS * 2);
    let expected = START_BOARD.map((r) => [...r]);
    for (const dir of adapter.sent) {
      if (isValidMove(expected, dir)) {
        expected = simulateMove(expected, dir);
      }
    }
    assert.deepEqual(adapter.readBoard(), expected);
    driver.stop();
  });
});
