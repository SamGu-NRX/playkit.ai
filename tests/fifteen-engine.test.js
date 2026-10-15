/**
 * @fileoverview Tests for the FifteenSolverEngine wrapper: one-move plans,
 * plan advancement, drift-triggered replanning, and refusal cases.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Direction } from "../src/adapters/adapter.js";
import {
  applyFifteenMove,
  FIFTEEN_GOAL,
  solveFifteen,
} from "../src/solver/fifteen-solver.js";
import { FifteenSolverEngine } from "../src/solver/fifteen-engine.js";

const UP = Direction.UP;
const RIGHT = Direction.RIGHT;
const DOWN = Direction.DOWN;
const LEFT = Direction.LEFT;

// Fixed scramble from the goal, skipping edge-illegal moves (deterministic).
function scramble(moves) {
  let board = FIFTEEN_GOAL.map((row) => [...row]);
  for (const move of moves) {
    const next = applyFifteenMove(board, move);
    if (next) board = next;
  }
  return board;
}

function isGoal(board) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (board[r][c] !== FIFTEEN_GOAL[r][c]) return false;
    }
  }
  return true;
}

test("engine emits the optimal first move and advances the plan", async () => {
  const start = scramble([DOWN, RIGHT, UP, LEFT, DOWN, RIGHT]);
  const expected = solveFifteen(start).moves.length;
  assert.ok(expected > 0);

  const engine = new FifteenSolverEngine();
  await engine.initialize();

  let board = start;
  const played = [];
  while (!isGoal(board)) {
    const order = await engine.getMoveOrder(board);
    assert.equal(order.length, 1, "engine proposes exactly one direction");
    const next = applyFifteenMove(board, order[0]);
    assert.ok(next, "engine move must be applicable");
    board = next;
    played.push(order[0]);
  }

  assert.equal(
    played.length,
    expected,
    "engine plays the full optimal sequence"
  );

  // Once solved the engine has nothing to add.
  const done = await engine.getMoveOrder(board);
  assert.deepEqual(done, []);
});

test("engine replans when the page drifts off the cached plan", async () => {
  const start = scramble([DOWN, RIGHT, UP, LEFT, DOWN, RIGHT, UP, LEFT]);
  const engine = new FifteenSolverEngine();
  await engine.initialize();

  const first = await engine.getMoveOrder(start);
  assert.equal(first.length, 1);

  // Simulate drift: a different board than the plan expects.
  const drifted = scramble([RIGHT, DOWN, RIGHT, UP]);
  const after = await engine.getMoveOrder(drifted);

  assert.equal(after.length, 1, "engine still proposes a move after drift");
  const next = applyFifteenMove(drifted, after[0]);
  assert.ok(next, "replanned move must be applicable");

  // Following the engine from the drifted board still reaches the goal.
  let board = drifted;
  for (let i = 0; i < 30; i++) {
    if (isGoal(board)) break;
    const order = await engine.getMoveOrder(board);
    assert.equal(order.length, 1);
    board = applyFifteenMove(board, order[0]);
  }
  assert.ok(isGoal(board), "engine recovers to the goal after drift");
});

test("engine refuses unsolvable boards", async () => {
  const engine = new FifteenSolverEngine();
  const swapped = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 15, 14, 0],
  ];
  const order = await engine.getMoveOrder(swapped);
  assert.deepEqual(order, []);
});

test("engine refuses garbage input", async () => {
  const engine = new FifteenSolverEngine();
  assert.deepEqual(await engine.getMoveOrder(null), []);
  assert.deepEqual(await engine.getMoveOrder("nope"), []);
});

test("getStatus reports plan state", async () => {
  const engine = new FifteenSolverEngine();
  const start = scramble([DOWN, RIGHT, UP, LEFT]);
  let status = engine.getStatus();
  assert.equal(status.ready, true);
  assert.equal(status.hasPlan, false);

  await engine.getMoveOrder(start);
  status = engine.getStatus();
  assert.equal(status.hasPlan, true);
  assert.equal(status.planIndex, 1);
  assert.ok(status.lastSolveNodes > 0);

  engine.resetPlan();
  assert.equal(engine.getStatus().hasPlan, false);
});
