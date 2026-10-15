/**
 * 2048 rules primitives: pure, browser-safe (no `node:*`), no clocks, no
 * `Math.random`. A board is a 4x4 `number[][]` of tile values with 0 for
 * empty, rows ordered top to bottom — the same shape the overlay's adapters
 * return from `readBoard()` (see `src/adapters/play2048-adapter.js`).
 *
 * Everything here is pure: no input is mutated, every call returns fresh
 * data, so results survive a JSON round trip and replays are exact.
 *
 * The four named exports `slide`, `emptyCells`, `placeTile` and
 * `observationForBoard` are a fixed interface: a later packet referees live
 * overlay pages through them. `spawnTile` is an extra export used by the
 * game in `index.js`.
 *
 * @module
 */

import { nextFloat, nextInt } from '../../core/rng.js';

/** @import { RngState } from '../../core/rng.js' */

/**
 * A tile board: 4 rows (top to bottom) of 4 tile values, 0 = empty.
 * @typedef {number[][]} Board
 */

/**
 * A slide direction.
 * @typedef {'up' | 'right' | 'down' | 'left'} Direction
 */

/**
 * The four directions in canonical (definition) order. `legalActions`
 * returns the legal subset sorted lexicographically.
 * @type {Direction[]}
 */
export const DIRECTIONS = ['up', 'right', 'down', 'left'];

/**
 * Probability the spawned tile is a 2 (else a 4).
 */
export const SPAWN_TWO_PROBABILITY = 0.9;

/**
 * Slide and merge one board. Tiles nearest the wall in the slide direction
 * are processed first; a tile merges at most once per move; a merge scores
 * the new tile's value. A move that changes nothing reports `moved: false`
 * and returns the board unchanged in values (still a fresh array).
 *
 * @param {Board} board
 * @param {Direction} dir
 * @returns {{ board: Board, gained: number, moved: boolean }}
 */
export function slide(board, dir) {
  const n = board.length;
  const out = board.map((row) => row.slice());
  const vertical = dir === 'up' || dir === 'down';
  const reverse = dir === 'down' || dir === 'right';
  let gained = 0;
  let moved = false;
  for (let line = 0; line < n; line++) {
    // Collect the values along the movement line, nearest-wall first.
    const values = [];
    for (let i = 0; i < n; i++) {
      const r = vertical ? (reverse ? n - 1 - i : i) : line;
      const c = vertical ? line : (reverse ? n - 1 - i : i);
      const v = board[r][c];
      if (v !== 0) values.push(v);
    }
    // Merge equal neighbours once, nearest wall first.
    const merged = [];
    for (let i = 0; i < values.length; i++) {
      if (i + 1 < values.length && values[i] === values[i + 1]) {
        const v = values[i] * 2;
        merged.push(v);
        gained += v;
        i++;
      } else {
        merged.push(values[i]);
      }
    }
    while (merged.length < n) merged.push(0);
    for (let i = 0; i < n; i++) {
      const r = vertical ? (reverse ? n - 1 - i : i) : line;
      const c = vertical ? line : (reverse ? n - 1 - i : i);
      if (out[r][c] !== merged[i]) moved = true;
      out[r][c] = merged[i];
    }
  }
  return { board: out, gained, moved };
}

/**
 * The empty cells of a board, as `[row, column]` pairs in row-major order.
 *
 * @param {Board} board
 * @returns {[number, number][]}
 */
export function emptyCells(board) {
  /** @type {[number, number][]} */
  const cells = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (board[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * Place a tile value on a copy of the board.
 *
 * @param {Board} board
 * @param {number} r Row, 0 = top.
 * @param {number} c Column, 0 = left.
 * @param {number} value Tile value (2, 4, 8, ...).
 * @returns {Board}
 */
export function placeTile(board, r, c, value) {
  if (!Number.isInteger(r) || r < 0 || r >= board.length) {
    throw new RangeError(`placeTile: row ${r} out of range`);
  }
  if (!Number.isInteger(c) || c < 0 || c >= board[r].length) {
    throw new RangeError(`placeTile: column ${c} out of range`);
  }
  const out = board.map((row) => row.slice());
  out[r][c] = value;
  return out;
}

/**
 * Spawn one tile on a board, drawn from an RNG state: first the value
 * (2 with probability 0.9, else 4, via one `nextFloat`), then the cell
 * (uniform over the empty cells, via one `nextInt`). Pure: the input board
 * and RNG state are untouched.
 *
 * @param {Board} board Must have at least one empty cell.
 * @param {RngState} rng
 * @returns {{ board: Board, rng: RngState }}
 */
export function spawnTile(board, rng) {
  const empties = emptyCells(board);
  if (empties.length === 0) {
    throw new Error('spawnTile: board has no empty cell');
  }
  const valueDraw = nextFloat(rng);
  const value = valueDraw.value < SPAWN_TWO_PROBABILITY ? 2 : 4;
  const cellDraw = nextInt(valueDraw.state, 0, empties.length - 1);
  const [r, c] = empties[cellDraw.value];
  return { board: placeTile(board, r, c, value), rng: cellDraw.state };
}

/**
 * @param {Board} board
 * @returns {number}
 */
export function maxTile(board) {
  let max = 0;
  for (const row of board) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max;
}

/**
 * Build the observation for a board and score. `data` carries the full
 * board (perfect information); `text` renders it. The game in `index.js`
 * appends tier and legal-action lines around this.
 *
 * @param {Board} board
 * @param {number} score
 * @returns {import('../../core/types.js').Observation}
 */
export function observationForBoard(board, score) {
  const width = Math.max(
    2,
    String(maxTile(board)).length
  );
  const bar = `+${Array.from({ length: board.length }, () => '-'.repeat(width + 2)).join('+')}+`;
  /** @type {string[]} */
  const lines = [bar];
  for (const row of board) {
    const cells = row.map((v) => (v === 0 ? ' '.repeat(width) : String(v).padStart(width, ' ')));
    lines.push(`| ${cells.join(' | ')} |`);
    lines.push(bar);
  }
  lines.push(`Score: ${score}`);
  return {
    text: lines.join('\n'),
    data: { board: board.map((row) => row.slice()), score },
  };
}
