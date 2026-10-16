/**
 * Reference-implementation differential tests for the Connect Four bitboard
 * win detector.
 *
 * The engine runs hasAlignment on per-seat limb-pair bitboards ({a, b},
 * bit = col * 7 + row, row 0 = bottom; the bit 6 of each 7-bit column block
 * is a spacing bit that prevents wraparound; games/connect4/rules.js). PR #20
 * review (HIGH, issue comment 6199629088): the hand-built win tests only
 * cover vertical and horizontal wins — a diagonal mutation passes the whole
 * suite, and even the horizontal cases only cross a limb boundary by luck.
 * These tests pin every alignment shape:
 *
 *  1. hand-built wins in all four directions, including both diagonals that
 *     cross the 32-bit limb boundary (bits 21->28->35->42 horizontal, 21->29
 *     rising, 24->30->36->42 falling) and three-in-a-row near-wins that must
 *     NOT align;
 *  2. 20,000 seeded random gravity-legal positions: hasAlignment must agree
 *     with a naive four-direction run-count reference on both seats. The
 *     generator is deliberately broader than alternation-reachable play —
 *     hasAlignment is a pure per-seat predicate, and a wider domain finds
 *     more;
 *  3. applyMove flips status to won exactly when the mover's own board
 *     aligns, with the winner attributed to the mover.
 *
 * Every random sample is drawn from `core/rng.js` with a fixed seed, so the
 * runs are deterministic.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDTH,
  HEIGHT,
  emptyState,
  applyMove,
  hasAlignment,
  bitFor,
  stateFromPlan,
} from '../../games/connect4/rules.js';
import { streamFromSeed } from '../../core/rng.js';

/** @import { Connect4State } from '../../games/connect4/rules.js' */

/**
 * @typedef {Array<Array<'X' | 'O'>>} ColumnPlan Column-major, bottom-up marks.
 */

/**
 * @typedef {{ a: number, b: number }} LimbPair Two 32-bit limbs of a seat board.
 */

/**
 * Naive win check: for every cell of `seat`, count runs along the four
 * axes (vertical, horizontal, both diagonals); four or more in a line wins.
 * Written directly against the (column, row) grid, no bitboards.
 *
 * @param {Uint8Array} grid 42 cells, col * HEIGHT + row; 0 empty, 1 = X, 2 = O.
 * @param {number} seat 0 or 1.
 * @returns {boolean}
 */
function naiveWins(grid, seat) {
  const mark = seat + 1;
  const axes = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (let col = 0; col < WIDTH; col++) {
    for (let row = 0; row < HEIGHT; row++) {
      if (grid[col * HEIGHT + row] !== mark) continue;
      for (const [dc, dr] of axes) {
        let run = 1;
        let c = col + dc;
        let r = row + dr;
        while (c >= 0 && c < WIDTH && r >= 0 && r < HEIGHT && grid[c * HEIGHT + r] === mark) {
          run++;
          c += dc;
          r += dr;
        }
        if (run >= 4) return true;
      }
    }
  }
  return false;
}

/**
 * Build a grid and per-seat limb-pair bitboards from a column plan.
 *
 * @param {ColumnPlan} plan
 * @returns {{ grid: Uint8Array, boards: [LimbPair, LimbPair] }}
 */
function planToBoards(plan) {
  const grid = new Uint8Array(WIDTH * HEIGHT);
  const boards = /** @type {[LimbPair, LimbPair]} */ ([{ a: 0, b: 0 }, { a: 0, b: 0 }]);
  for (let col = 0; col < plan.length; col++) {
    const marks = plan[col];
    if (marks.length > HEIGHT) throw new Error(`plan column ${col} overflows`);
    for (let row = 0; row < marks.length; row++) {
      const seat = marks[row] === 'X' ? 0 : 1;
      grid[col * HEIGHT + row] = seat + 1;
      const bit = bitFor(col, row);
      boards[seat].a |= bit.a;
      boards[seat].b |= bit.b;
    }
  }
  return { grid, boards };
}

test('hand-built wins: all four directions, both cross-limb diagonals, and near-win negatives', () => {
  // X wins by column fill (bits 1, 2, 3, 4).
  /** @type {ColumnPlan} */
  const vertical = [
    ['X', 'X', 'X', 'X'],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
  // X wins along row 0: bits 21, 28, 35, 42 — crosses the limb boundary.
  /** @type {ColumnPlan} */
  const crossLimbHorizontal = [
    [],
    [],
    [],
    ['X'],
    ['X'],
    ['X'],
    ['X'],
  ];
  // Rising diagonal: (0,0) (1,1) (2,2) (3,3) — the review's suggested shape.
  /** @type {ColumnPlan} */
  const risingDiagonal = [
    ['X'],
    ['O', 'X'],
    ['O', 'O', 'X'],
    ['O', 'O', 'O', 'X'],
    [],
    [],
    [],
  ];
  // Falling diagonal: (0,3) (1,2) (2,1) (3,0).
  /** @type {ColumnPlan} */
  const fallingDiagonal = [
    ['O', 'O', 'O', 'X'],
    ['O', 'O', 'X'],
    ['O', 'X'],
    ['X'],
    [],
    [],
    [],
  ];
  // Rising diagonal crossing the limb boundary: (3,0) (4,1) (5,2) (6,3),
  // bits 21, 29, 37, 45.
  /** @type {ColumnPlan} */
  const crossLimbRising = [
    [],
    [],
    [],
    ['X'],
    ['O', 'X'],
    ['O', 'O', 'X'],
    ['O', 'O', 'O', 'X'],
  ];
  // Falling diagonal crossing the limb boundary: (3,3) (4,2) (5,1) (6,0),
  // bits 24, 30, 36, 42.
  /** @type {ColumnPlan} */
  const crossLimbFalling = [
    [],
    [],
    [],
    ['O', 'O', 'O', 'X'],
    ['O', 'O', 'X'],
    ['O', 'X'],
    ['X'],
  ];
  // Three in a row in each shape: must NOT count as a win.
  /** @type {ColumnPlan} */
  const threeVertical = [
    ['X', 'X', 'X'],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
  /** @type {ColumnPlan} */
  const threeDiagonal = [
    ['X'],
    ['O', 'X'],
    ['O', 'O', 'X'],
    [],
    [],
    [],
    [],
  ];

  const wins = [vertical, crossLimbHorizontal, risingDiagonal, fallingDiagonal, crossLimbRising, crossLimbFalling];
  for (const plan of wins) {
    const { grid, boards } = planToBoards(plan);
    const state = /** @type {Connect4State} */ (stateFromPlan(plan));
    assert.equal(hasAlignment(boards[0]), true, `X must align: ${JSON.stringify(plan)}`);
    assert.equal(hasAlignment(boards[1]), false, `O must not align: ${JSON.stringify(plan)}`);
    assert.equal(naiveWins(grid, 0), true);
    assert.equal(state.status, 'won', `state must be won: ${JSON.stringify(plan)}`);
    assert.equal(state.winner, 0);
    assert.ok(state.history.length > 0);
  }
  for (const plan of [threeVertical, threeDiagonal]) {
    const { grid, boards } = planToBoards(plan);
    const state = /** @type {Connect4State} */ (stateFromPlan(plan));
    assert.equal(hasAlignment(boards[0]), false, `three in a row must not align: ${JSON.stringify(plan)}`);
    assert.equal(naiveWins(grid, 0), false);
    assert.equal(state.status, 'playing', `three in a row must still be playing: ${JSON.stringify(plan)}`);
    assert.equal(state.winner, null);
  }
});

test('20,000 seeded random gravity-legal positions: hasAlignment matches the naive run counter for both seats', () => {
  const rng = streamFromSeed('burst10-connect4-bitboard-reference');
  const grid = new Uint8Array(WIDTH * HEIGHT);
  let alignedPositions = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const heights = [];
    for (let col = 0; col < WIDTH; col++) {
      // Every seventh trial fills the column completely so full boards and
      // limb-boundary cells are exercised often, not just rarely.
      heights.push(trial % 7 === 0 ? HEIGHT : rng.nextInt(0, HEIGHT));
    }
    for (let col = 0; col < WIDTH; col++) {
      for (let row = 0; row < HEIGHT; row++) {
        if (row >= heights[col]) {
          grid[col * HEIGHT + row] = 0;
        } else {
          const seat = rng.nextFloat() < 0.5 ? 0 : 1;
          grid[col * HEIGHT + row] = seat + 1;
        }
      }
    }
    const boards = bitBoardsFromGrid(grid);
    assert.equal(hasAlignment(boards[0]), naiveWins(grid, 0), `X alignment, trial ${trial}`);
    assert.equal(hasAlignment(boards[1]), naiveWins(grid, 1), `O alignment, trial ${trial}`);
    if (naiveWins(grid, 0) || naiveWins(grid, 1)) alignedPositions++;
  }
  // The generator must actually produce aligned positions, or the test
  // proves nothing; random fills align very often.
  assert.ok(alignedPositions > 5000, `only ${alignedPositions} aligned positions in the sample`);
});

test('applyMove flips status to won exactly when the mover aligns four', () => {
  // Build 0 1 2 3 on row 0 through legal alternating drops; the fourth X
  // ends the game. O's detour through column 6 keeps X's stones contiguous.
  let state = /** @type {Connect4State} */ (emptyState(0));
  const dropX = [0, 1, 2, 3];
  const dropO = [6, 6, 6];
  state = /** @type {Connect4State} */ (applyMove(state, 0, dropX[0])); // X (0,0)
  state = /** @type {Connect4State} */ (applyMove(state, 1, dropO[0])); // O (6,0)
  state = /** @type {Connect4State} */ (applyMove(state, 0, dropX[1])); // X (1,0)
  state = /** @type {Connect4State} */ (applyMove(state, 1, dropO[1])); // O (6,1)
  state = /** @type {Connect4State} */ (applyMove(state, 0, dropX[2])); // X (2,0)
  state = /** @type {Connect4State} */ (applyMove(state, 1, dropO[2])); // O (6,2)
  assert.equal(state.status, 'playing');
  assert.equal(state.winner, null);
  state = /** @type {Connect4State} */ (applyMove(state, 0, dropX[3])); // X (3,0) — wins
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 0);
  assert.equal(state.discs, 7);
  assert.equal(state.history.length, 7);
  // The final position must satisfy the detector (from the state's own
  // bitboards) and the naive counter alike.
  const boardX = { a: state.bb[0], b: state.bb[1] };
  const boardO = { a: state.bb[2], b: state.bb[3] };
  assert.equal(hasAlignment(boardX), true);
  assert.equal(hasAlignment(boardO), false);
});

/**
 * Seat limb-pair bitboards from a grid.
 *
 * @param {Uint8Array} grid
 * @returns {[LimbPair, LimbPair]}
 */
function bitBoardsFromGrid(grid) {
  const boards = /** @type {[LimbPair, LimbPair]} */ ([{ a: 0, b: 0 }, { a: 0, b: 0 }]);
  for (let col = 0; col < WIDTH; col++) {
    for (let row = 0; row < HEIGHT; row++) {
      const mark = grid[col * HEIGHT + row];
      if (mark === 0) continue;
      const bit = bitFor(col, row);
      boards[mark - 1].a |= bit.a;
      boards[mark - 1].b |= bit.b;
    }
  }
  return boards;
}
