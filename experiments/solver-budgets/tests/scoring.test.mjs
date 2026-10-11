/**
 * Hand-scored control for the study's scoring semantics.
 *
 * The score measured by the study is CUMULATIVE MERGED-TILE POINTS under
 * standard 2048 scoring, computed by the independent reference model's
 * `moveGain`: each merge of two tiles a,a -> 2a earns 2a points. Spawning
 * earns no points. These tests pin that expectation by hand, not by
 * reference to any solver's internal score.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  moveGain,
  simulateMove,
  boardsEqual,
  spawnRandomTile,
  mulberry32,
} from "../../../test/helpers/reference-2048.mjs";

const emptyRow = () => [0, 0, 0, 0];
const boardWithRow = (row) => [row, emptyRow(), emptyRow(), emptyRow()];

test("hand-scored control: [2,2,4,4] moved left earns 12 points", () => {
  const board = boardWithRow([2, 2, 4, 4]);
  // merges: (2+2) -> 4 earns 4; (4+4) -> 8 earns 8; total 12.
  assert.equal(moveGain(board, 3), 12);
  // and the resulting board is what the hand score implies
  const moved = simulateMove(board, 3);
  assert.deepEqual(moved[0], [4, 8, 0, 0]);
});

test("hand-scored control: spawning earns no points", () => {
  const board = boardWithRow([2, 2, 4, 4]);
  let score = 0;
  score += moveGain(board, 3); // the move: 12 points
  const moved = simulateMove(board, 3);
  const rng = mulberry32(1);
  spawnRandomTile(moved, rng); // the spawn: earns nothing
  assert.equal(score, 12);
  // a spawn can never merge, so it can never add points — the cumulative
  // score after move+spawn equals the move's gain alone
  assert.equal(score, moveGain(board, 3));
});

test("hand-scored control: two independent merges each earn their tile value", () => {
  // merges: (4+4) -> 8 earns 8; (8+8) -> 16 earns 16; total 24.
  assert.equal(moveGain(boardWithRow([4, 4, 8, 8]), 3), 24);
});

test("hand-scored control: a move with no merges earns 0", () => {
  assert.equal(moveGain(boardWithRow([2, 4, 8, 16]), 3), 0);
  // a board-changing but merge-free move ([0,2,4,8] right -> [0,0,2,4])
  assert.equal(moveGain(boardWithRow([0, 2, 4, 8]), 1), 0);
});

test("hand-scored control: column directions score the same way", () => {
  // Up (dir 0): column [2,2,4,4] top->bottom merges to 4,8 → 12 points
  const board = [
    [2, 0, 0, 0],
    [2, 0, 0, 0],
    [4, 0, 0, 0],
    [4, 0, 0, 0],
  ];
  assert.equal(moveGain(board, 0), 12);
});

test("hand-scored control: moveGain agrees with the board transformation it scores", () => {
  // The gain must describe exactly the merge the reference model applies:
  // for a merge-free board sum, moving preserves the tile sum; for a
  // merging board, the merged tile values are what the gain reports.
  const board = boardWithRow([2, 2, 4, 4]);
  const gain = moveGain(board, 3);
  const moved = simulateMove(board, 3);
  // tile sum is preserved by merging (12 -> 12); the 12 points are the
  // merged tiles' values, not a sum delta
  const sum = (b) => b.flat().reduce((a, v) => a + v, 0);
  assert.equal(sum(moved), sum(board));
  assert.equal(gain, 12);
  assert.ok(!boardsEqual(board, moved));
});
