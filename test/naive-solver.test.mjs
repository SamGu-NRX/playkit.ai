/**
 * NaiveSolverEngine + MOVE_SIMULATORS (src/solver/naive-solver.js),
 * cross-checked against the independent reference rules in
 * ./helpers/reference-2048.mjs (directions: 0=Up, 1=Right, 2=Down, 3=Left).
 * Run:
 *   node --test test/naive-solver.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_SIMULATORS, NaiveSolverEngine } from "../src/solver/naive-solver.js";
import {
  mulberry32,
  simulateMove,
  validMoves,
  isGameOver,
} from "./helpers/reference-2048.mjs";

/** 4x4 values board from a row-major flat array (16 entries). */
const fromFlat = (...flat) => [
  flat.slice(0, 4),
  flat.slice(4, 8),
  flat.slice(8, 12),
  flat.slice(12, 16),
];

const TILE_POOL = [2, 2, 2, 2, 4, 4, 8]; // ~57% twos, 29% fours, 14% eights

/** Seeded random board with 0-11 tiles from the pool. */
function randomBoard(rng) {
  const flat = Array(16).fill(0);
  const count = Math.floor(rng() * 12); // 0-11 tiles
  const cells = [...Array(16).keys()];
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (let i = 0; i < count; i++) flat[cells[i]] = TILE_POOL[Math.floor(rng() * TILE_POOL.length)];
  return fromFlat(...flat);
}

test("MOVE_SIMULATORS match the independent reference — fuzz N=20000 boards x 4 directions (seed 0xC0FFEE)", () => {
  const rng = mulberry32(0xc0ffee);
  for (let iter = 0; iter < 20000; iter++) {
    const board = randomBoard(rng);
    for (let dir = 0; dir < 4; dir++) {
      assert.deepEqual(
        MOVE_SIMULATORS[dir](board),
        simulateMove(board, dir),
        `mismatch at iter ${iter}, dir ${dir}, board ${JSON.stringify(board)}`,
      );
    }
    if (iter % 97 === 0) {
      // Simulators must be pure: sample-check that the input board survives.
      const snapshot = JSON.stringify(board);
      for (let dir = 0; dir < 4; dir++) MOVE_SIMULATORS[dir](board);
      assert.equal(JSON.stringify(board), snapshot, `input mutated at iter ${iter}`);
    }
  }
});

test("hand-written known answers (consistent with the reference fuzz above)", () => {
  // Left merges one pair.
  assert.deepEqual(
    MOVE_SIMULATORS[3](fromFlat(2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    fromFlat(4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  // [2,2,2,2] -> [4,4] (both pairs merge, result does not re-merge).
  assert.deepEqual(
    MOVE_SIMULATORS[3](fromFlat(2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    fromFlat(4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  // Two independent pairs merge in one move.
  assert.deepEqual(
    MOVE_SIMULATORS[3](fromFlat(4, 4, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    fromFlat(8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  // Up merges column 3.
  assert.deepEqual(
    MOVE_SIMULATORS[0](fromFlat(0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)),
    fromFlat(0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  // Right slides a lone tile to the wall.
  assert.deepEqual(
    MOVE_SIMULATORS[1](fromFlat(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    fromFlat(0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
});

test("fixture check: checkerboard board has NO valid move; the naive 'all rows merge' board is NOT dead", () => {
  // Verifies the dead-board example used by the FIX-2 skip below against the
  // independent reference before hard-coding it.
  const dead = fromFlat(2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2);
  assert.equal(isGameOver(dead), true);
  // The task-suggested example [[2,2,2,2],[4,4,4,4],[2,2,2,2],[4,4,4,4]] is
  // NOT dead: its rows still merge (Left turns [2,2,2,2] into [4,4,0,0]).
  assert.equal(isGameOver(fromFlat(2, 2, 2, 2, 4, 4, 4, 4, 2, 2, 2, 2, 4, 4, 4, 4)), false);
});

test("CURRENT behavior: dead board returns the padded all-four list (pins the FIX-2 game-over bug)", async () => {
  const engine = new NaiveSolverEngine();
  const dead = fromFlat(2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2);
  assert.deepEqual(await engine.getMoveOrder(dead), [0, 1, 2, 3]);
});

// TODO(FIX-2): when a board has NO valid move (game over), getMoveOrder must return [] instead of the padded all-four list; driver treats [] as game-over.
test.skip("getMoveOrder returns [] on a dead board (post FIX-2)", async () => {
  const engine = new NaiveSolverEngine();
  // Checkerboard: full board, no adjacent equal tiles, nothing can move
  // (deadness verified against the reference in the fixture test above).
  const dead = fromFlat(2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2);
  assert.deepEqual(await engine.getMoveOrder(dead), []);
});

test("CURRENT behavior: board with exactly one valid move still returns all four, valid one first (padding pin)", async () => {
  const engine = new NaiveSolverEngine();
  // Full checkerboard rows 0-2 (no merges) above an empty row: only Down
  // changes the board (columns slide into the empty row); verified via
  // reference. (A lone corner tile is NOT such a fixture — it can move both
  // Right and Up.)
  const board = fromFlat(2, 4, 2, 4, 4, 2, 4, 2, 8, 4, 2, 4, 0, 0, 0, 0);
  assert.deepEqual(validMoves(board), [2]); // only Down — verified via reference
  const order = await engine.getMoveOrder(board);
  assert.equal(order[0], 2, "the single valid direction must be first");
  assert.deepEqual([...new Set(order)].sort((a, b) => a - b), [0, 1, 2, 3]); // padded to four
});

test("getMoveOrder resolves (never throws) for degenerate boards", async () => {
  const engine = new NaiveSolverEngine();
  const boards = [
    fromFlat(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // empty
    fromFlat(2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2), // dead
    fromFlat(NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // non-finite coerced to 0
    fromFlat(2.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // fractional tile
  ];
  for (const board of boards) {
    await assert.doesNotReject(() => engine.getMoveOrder(board));
  }
  // Empty board: nothing can move -> padded all-four (same game-over quirk
  // as FIX-2; pinned as current behavior).
  assert.deepEqual(await engine.getMoveOrder(boards[0]), [0, 1, 2, 3]);
});

test("invalid input: rejects with the BoardEncoder shape error (pinned current behavior)", async () => {
  const engine = new NaiveSolverEngine();
  await assert.rejects(() => engine.getMoveOrder(undefined), /expected a 4x4 matrix/);
  await assert.rejects(() => engine.getMoveOrder([[2, 2], [2, 2]]), /expected a 4x4 matrix/);
  await assert.rejects(() => engine.getMoveOrder([1, 2, 3, 4]), /expected a 4x4 matrix/);
});

test("getStatus/setStrategy pins (bias defaults to DOWN = 2)", async () => {
  const engine = new NaiveSolverEngine();
  assert.deepEqual(engine.getStatus(), { type: "naive", ready: true, strategy: { bias: 2 } });
  await engine.setStrategy({ bias: 0 }); // UP = 0
  assert.equal(engine.getStatus().strategy.bias, 0);
  await engine.setStrategy({ bias: "not-a-number" }); // non-number ignored
  assert.equal(engine.getStatus().strategy.bias, 0);
});
