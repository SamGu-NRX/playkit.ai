/**
 * @fileoverview Classic 15-puzzle (sliding tile) solver.
 *
 * Pure, DOM-free logic: a 4x4 board is a matrix of tile values 1..15 with 0
 * for the blank. Moves are expressed with the shared Direction constants and
 * follow the tile-movement convention used by the site adapters: a direction
 * names where the TILE slides, so pressing RIGHT slides the tile to the left
 * of the blank rightward (the blank moves left). This matches the arrow-key
 * handlers of public 15-puzzle pages (e.g. the keydown handler of
 * lorecioni.github.io/fifteen-puzzle-game, which moves the tile at
 * (blank.row, blank.col - 1) for ArrowRight).
 *
 * solve() runs IDA* with an admissible heuristic (Manhattan distance plus
 * linear conflicts), so the returned move sequence is optimal. Unsolvable
 * boards are rejected in O(n^2) via the classic inversion-parity check.
 */

import { Direction } from "../adapters/adapter.js";

export const FIFTEEN_GOAL = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 0],
];

const SIZE = 4;
const DIRECTION_ORDER = [
  Direction.UP,
  Direction.RIGHT,
  Direction.DOWN,
  Direction.LEFT,
];

// Opposite direction pairs, used to prune immediate move reversals in IDA*.
const OPPOSITE = {
  [Direction.UP]: Direction.DOWN,
  [Direction.DOWN]: Direction.UP,
  [Direction.LEFT]: Direction.RIGHT,
  [Direction.RIGHT]: Direction.LEFT,
};

/**
 * Validate that a board is a 4x4 matrix containing each of 0..15 exactly once.
 * @param {any} board
 * @returns {boolean}
 */
export function isValidFifteenBoard(board) {
  if (!Array.isArray(board) || board.length !== SIZE) return false;
  const seen = new Set();
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    for (const value of row) {
      if (!Number.isInteger(value) || value < 0 || value > 15) return false;
      if (seen.has(value)) return false;
      seen.add(value);
    }
  }
  return seen.size === 16;
}

/**
 * Apply a move to a copy of the board. Direction follows the tile-movement
 * convention documented at the top of this file. Returns null when the move
 * is impossible (no tile can slide in that direction).
 * @param {number[][]} board
 * @param {number} direction
 * @returns {number[][]|null}
 */
export function applyFifteenMove(board, direction) {
  const blank = findBlank(board);
  if (!blank) return null;

  // Where the blank must move for a tile to slide in `direction`.
  let dr = 0;
  let dc = 0;
  if (direction === Direction.UP) {
    dr = 1; // tile below the blank slides up
  } else if (direction === Direction.DOWN) {
    dr = -1; // tile above the blank slides down
  } else if (direction === Direction.RIGHT) {
    dc = -1; // tile left of the blank slides right
  } else if (direction === Direction.LEFT) {
    dc = 1; // tile right of the blank slides left
  } else {
    return null;
  }

  const r = blank.row + dr;
  const c = blank.col + dc;
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;

  const next = board.map((row) => [...row]);
  next[blank.row][blank.col] = next[r][c];
  next[r][c] = 0;
  return next;
}

/**
 * Check whether every tile sits at its goal position.
 * @param {number[][]} board
 * @returns {boolean}
 */
export function isFifteenSolved(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== FIFTEEN_GOAL[r][c]) return false;
    }
  }
  return true;
}

function findBlank(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Solvability via inversion parity: for an even-width grid the puzzle is
 * solvable iff inversions + blank row counted from the bottom is odd.
 * The classic unsolvable 14-15 swap fails this check.
 * @param {number[][]} board
 * @returns {boolean}
 */
export function isFifteenSolvable(board) {
  const flat = [];
  let blankRowFromBottom = 1;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === 0) {
        blankRowFromBottom = SIZE - r;
      } else {
        flat.push(board[r][c]);
      }
    }
  }

  let inversions = 0;
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[i] > flat[j]) inversions++;
    }
  }

  return (inversions + blankRowFromBottom) % 2 === 1;
}

/**
 * Admissible heuristic: Manhattan distance plus linear conflicts.
 * @param {number[][]} board
 * @returns {number}
 */
export function fifteenHeuristic(board) {
  let h = 0;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const value = board[r][c];
      if (value === 0) continue;
      const goalRow = Math.floor((value - 1) / SIZE);
      const goalCol = (value - 1) % SIZE;
      h += Math.abs(r - goalRow) + Math.abs(c - goalCol);
    }
  }

  // Linear conflicts (Hansson/Mayer/Yung form): for each line (row or
  // column), the tiles already in their goal line must appear in goal order
  // in any solution, so the tiles outside the longest strictly-increasing
  // subsequence of their goal indices must each leave the line at least
  // once — two extra moves apiece. Counting reversed *pairs* instead (as an
  // earlier version did) is inadmissible when one tile conflicts with two
  // or more others: row [3,1,2] of its goal row would add 4 where at most
  // 2 extra moves are needed.
  for (let r = 0; r < SIZE; r++) {
    const goalCols = [];
    for (let c = 0; c < SIZE; c++) {
      const v = board[r][c];
      if (v !== 0 && Math.floor((v - 1) / SIZE) === r) goalCols.push((v - 1) % SIZE);
    }
    h += 2 * (goalCols.length - longestIncreasingLength(goalCols));
  }
  for (let c = 0; c < SIZE; c++) {
    const goalRows = [];
    for (let r = 0; r < SIZE; r++) {
      const v = board[r][c];
      if (v !== 0 && (v - 1) % SIZE === c) goalRows.push(Math.floor((v - 1) / SIZE));
    }
    h += 2 * (goalRows.length - longestIncreasingLength(goalRows));
  }

  return h;
}

/**
 * Length of the longest strictly increasing subsequence. Lines have at most
 * SIZE (4) in-line tiles, so the simple O(n^2) DP is plenty.
 * @param {number[]} values
 * @returns {number}
 */
function longestIncreasingLength(values) {
  if (values.length === 0) return 0;
  const best = new Array(values.length).fill(1);
  let max = 1;
  for (let i = 1; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i] && best[j] + 1 > best[i]) best[i] = best[j] + 1;
    }
    if (best[i] > max) max = best[i];
  }
  return max;
}

/**
 * Solve a board with IDA*. Returns:
 *   { status: "solved", moves: number[] }   optimal move sequence (possibly [])
 *   { status: "unsolvable", moves: null }
 *   { status: "budget", moves: null, nodes } node budget exhausted
 *   { status: "invalid", moves: null }
 * @param {number[][]} board
 * @param {{maxNodes?: number}} options
 */
export function solveFifteen(board, options = {}) {
  const maxNodes = options.maxNodes ?? 400000;

  if (!isValidFifteenBoard(board)) {
    return { status: "invalid", moves: null, nodes: 0 };
  }
  if (isFifteenSolved(board)) {
    return { status: "solved", moves: [], nodes: 0 };
  }
  if (!isFifteenSolvable(board)) {
    return { status: "unsolvable", moves: null, nodes: 0 };
  }

  let nodes = 0;
  let budgetExhausted = false;
  const path = [];

  const search = (work, blankR, blankC, g, threshold, lastDir) => {
    const h = fifteenHeuristic(work);
    const f = g + h;
    if (f > threshold) return f;
    if (h === 0) return -1; // found

    if (++nodes > maxNodes) {
      budgetExhausted = true;
      return Infinity;
    }

    let minNext = Infinity;
    for (const dir of DIRECTION_ORDER) {
      if (path.length > 0 && OPPOSITE[dir] === lastDir) continue;

      const dr = dir === Direction.UP ? 1 : dir === Direction.DOWN ? -1 : 0;
      const dc = dir === Direction.RIGHT ? -1 : dir === Direction.LEFT ? 1 : 0;
      const r = blankR + dr;
      const c = blankC + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;

      work[blankR][blankC] = work[r][c];
      work[r][c] = 0;
      path.push(dir);

      const result = search(work, r, c, g + 1, threshold, dir);
      if (result === -1) return -1;
      if (result < minNext) minNext = result;

      path.pop();
      work[r][c] = work[blankR][blankC];
      work[blankR][blankC] = 0;

      if (budgetExhausted) return Infinity;
    }
    return minNext;
  };

  const work = board.map((row) => [...row]);
  let threshold = fifteenHeuristic(work);

  while (threshold <= 80) {
    const blank = findBlank(work);
    const result = search(work, blank.row, blank.col, 0, threshold, -1);
    if (result === -1) {
      return { status: "solved", moves: [...path], nodes };
    }
    if (budgetExhausted) {
      return { status: "budget", moves: null, nodes };
    }
    threshold = result;
  }

  return { status: "budget", moves: null, nodes };
}
