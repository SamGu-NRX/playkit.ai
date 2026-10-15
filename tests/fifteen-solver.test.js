/**
 * @fileoverview Unit tests for the 15-puzzle solver: correctness of
 * solvability, move application, and optimality of IDA* against an
 * independent breadth-first reference for small fixed boards.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FIFTEEN_GOAL,
  applyFifteenMove,
  fifteenHeuristic,
  isFifteenSolvable,
  isFifteenSolved,
  isValidFifteenBoard,
  solveFifteen,
} from "../src/solver/fifteen-solver.js";
import { Direction } from "../src/adapters/adapter.js";

const UP = Direction.UP;
const RIGHT = Direction.RIGHT;
const DOWN = Direction.DOWN;
const LEFT = Direction.LEFT;

// Apply a fixed scramble from the goal, skipping edge-illegal moves so the
// sequence is always a real position (deterministic).
function scramble(moves) {
  let board = FIFTEEN_GOAL.map((row) => [...row]);
  for (const move of moves) {
    const next = applyFifteenMove(board, move);
    if (next) board = next;
  }
  return board;
}

function applySequence(board, moves) {
  let current = board.map((row) => [...row]);
  for (const move of moves) {
    const next = applyFifteenMove(current, move);
    assert.ok(next, `move ${move} should be applicable`);
    current = next;
  }
  return current;
}

// Independent BFS reference (does not share solver internals).
function bfsOptimalLength(start, maxDepth = 16) {
  const key = (b) => b.flat().join(",");
  const goalKey = key(FIFTEEN_GOAL);
  let frontier = [{ board: start.map((r) => [...r]), depth: 0 }];
  const seen = new Set([key(start)]);
  while (frontier.length) {
    const next = [];
    for (const { board, depth } of frontier) {
      if (key(board) === goalKey) return depth;
      if (depth === maxDepth) continue;
      for (const dir of [UP, RIGHT, DOWN, LEFT]) {
        const nb = applyFifteenMove(board, dir);
        if (!nb) continue;
        const k = key(nb);
        if (!seen.has(k)) {
          seen.add(k);
          next.push({ board: nb, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return null;
}

test("goal board is valid, solved, and solvable", () => {
  assert.ok(isValidFifteenBoard(FIFTEEN_GOAL));
  assert.ok(isFifteenSolved(FIFTEEN_GOAL));
  assert.ok(isFifteenSolvable(FIFTEEN_GOAL));
});

test("invalid boards are rejected", () => {
  assert.equal(isValidFifteenBoard(null), false);
  assert.equal(isValidFifteenBoard([[1, 2, 3, 4]]), false);
  const duplicate = [
    [1, 1, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 0],
  ];
  assert.equal(isValidFifteenBoard(duplicate), false);
  const outOfRange = [
    [1, 2, 3, 16],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 0],
  ];
  assert.equal(isValidFifteenBoard(outOfRange), false);
});

test("solvability rejects the classic unsolvable 14-15 swap", () => {
  const swapped = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 15, 14, 0],
  ];
  assert.ok(isValidFifteenBoard(swapped));
  assert.equal(isFifteenSolvable(swapped), false);
  assert.equal(solveFifteen(swapped).status, "unsolvable");
});

test("move application follows the tile-movement convention", () => {
  // Blank at bottom-right: pressing RIGHT slides tile 15 rightward, and
  // pressing LEFT afterward slides it back.
  const afterRight = applyFifteenMove(FIFTEEN_GOAL, RIGHT);
  assert.deepEqual(afterRight, [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 0, 15],
  ]);
  assert.deepEqual(applyFifteenMove(afterRight, LEFT), FIFTEEN_GOAL);

  // Impossible moves return null: from the goal, no tile sits above the
  // blank (UP) or to its right (LEFT)... a tile sits BELOW the blank (so
  // DOWN is legal) — UP and LEFT are the impossible ones.
  assert.equal(applyFifteenMove(FIFTEEN_GOAL, UP), null);
  assert.equal(applyFifteenMove(FIFTEEN_GOAL, LEFT), null);
  assert.ok(applyFifteenMove(FIFTEEN_GOAL, DOWN));
  assert.equal(applyFifteenMove(FIFTEEN_GOAL, "bogus"), null);

  // Inputs are not mutated.
  const before = JSON.stringify(FIFTEEN_GOAL);
  applyFifteenMove(FIFTEEN_GOAL, DOWN);
  assert.equal(JSON.stringify(FIFTEEN_GOAL), before);
});

test("heuristic is zero on the goal and grows with distance", () => {
  assert.equal(fifteenHeuristic(FIFTEEN_GOAL), 0);
  const oneMove = applyFifteenMove(FIFTEEN_GOAL, RIGHT);
  assert.equal(fifteenHeuristic(oneMove), 1);
  // Linear conflict: goal with the last row rotated is worth more than
  // plain Manhattan distance (which would count 4). The admissible penalty
  // is 2 × (tiles in line − longest non-conflicting subsequence):
  // [14, 15, 13] has LIS {14,15} → one conflicting tile → +2, total 6.
  // Pairwise pair-counting would (wrongly) add 4 here and total 8.
  const conflicted = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [14, 15, 13, 0],
  ];
  assert.equal(fifteenHeuristic(conflicted), 6);
});

test("heuristic stays admissible when one tile conflicts with two others", () => {
  // Row 3,1,2 of its goal row: tile 13 conflicts with both 14 and 15.
  // Pairwise counting adds 4 (two reversed pairs); the admissible penalty
  // is 2 (LIS {14,15} of goal indices [1,2,0] → 3 − 2 = 1 tile must leave).
  const rotated = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [14, 15, 13, 0],
  ];
  const optimal = bfsOptimalLength(rotated, 20);
  assert.ok(optimal !== null);
  assert.ok(
    fifteenHeuristic(rotated) <= optimal,
    `h=${fifteenHeuristic(rotated)} must not exceed true distance ${optimal}`
  );

  // Reviewer repro: pairwise counting made h exceed the true distance on
  // this board, so IDA* returned 17 moves where the optimum is 15.
  const repro = [
    [1, 3, 7, 4],
    [5, 10, 0, 8],
    [9, 2, 12, 15],
    [13, 6, 14, 11],
  ];
  const reproOptimal = bfsOptimalLength(repro, 20);
  assert.equal(reproOptimal, 15, "BFS reference pins the optimum at 15");
  assert.ok(
    fifteenHeuristic(repro) <= reproOptimal,
    `h=${fifteenHeuristic(repro)} must not exceed true distance ${reproOptimal}`
  );
});

test("solver returns the BFS optimum on multi-conflict boards", () => {
  const cases = [
    // Reviewer repro: pairwise linear conflict returned 17 here.
    [
      [1, 3, 7, 4],
      [5, 10, 0, 8],
      [9, 2, 12, 15],
      [13, 6, 14, 11],
    ],
    // Single 3-cycle in the goal row.
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [14, 15, 13, 0],
    ],
  ];

  for (const board of cases) {
    const expected = bfsOptimalLength(board, 20);
    assert.ok(expected !== null, "BFS reference should reach the goal");
    const result = solveFifteen(board);
    assert.equal(result.status, "solved", JSON.stringify(board));
    assert.equal(
      result.moves.length,
      expected,
      `move count must be optimal (BFS: ${expected})`
    );
    assert.ok(isFifteenSolved(applySequence(board, result.moves)));
  }
});

test("solver returns optimal sequences matching BFS on fixed boards", () => {
  const cases = [
    FIFTEEN_GOAL,
    scramble([RIGHT]),
    scramble([DOWN, RIGHT, UP, LEFT]),
    scramble([RIGHT, DOWN, RIGHT, UP, LEFT, DOWN]),
    scramble([
      RIGHT, DOWN, LEFT, DOWN, RIGHT, UP, RIGHT, DOWN,
      LEFT, LEFT, UP,
    ]),
  ];

  for (const board of cases) {
    const expected = bfsOptimalLength(board);
    assert.ok(expected !== null, "BFS reference should reach the goal");
    const result = solveFifteen(board);
    assert.equal(result.status, "solved", JSON.stringify(board));
    assert.equal(result.moves.length, expected, "move count must be optimal");

    // Replaying the returned moves must land on the goal.
    const replayed = applySequence(board, result.moves);
    assert.ok(isFifteenSolved(replayed));
  }
});

test("solver solves the fixture scramble from the captured site", () => {
  // The board baked into tests/fixtures/fifteen-puzzle-page.html.
  const fixtureBoard = [
    [1, 2, 3, 4],
    [5, 12, 8, 10],
    [9, 6, 7, 0],
    [13, 14, 11, 15],
  ];
  const expected = bfsOptimalLength(fixtureBoard, 20);
  assert.equal(expected, 15);

  const result = solveFifteen(fixtureBoard);
  assert.equal(result.status, "solved");
  assert.equal(result.moves.length, expected);
  assert.ok(isFifteenSolved(applySequence(fixtureBoard, result.moves)));
});

test("node budget is respected", () => {
  // A depth-42 scramble needs 298 nodes; a 100-node budget must abort with
  // status "budget" instead of returning a partial answer.
  const deep = [
    [4, 8, 6, 12],
    [14, 13, 1, 15],
    [0, 9, 10, 3],
    [5, 2, 7, 11],
  ];
  assert.ok(solveFifteen(deep).status === "solved");

  const result = solveFifteen(deep, { maxNodes: 100 });
  assert.equal(result.status, "budget");
  assert.equal(result.moves, null);
  assert.ok(result.nodes > 100);
});
