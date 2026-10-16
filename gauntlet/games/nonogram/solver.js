/**
 * Whole-grid Nonogram solving: fixpoint line propagation, contradiction
 * probing, and solution counting.
 *
 * Cells: 0 = unknown, 1 = filled, 2 = crossed. A puzzle's clues fix a
 * (possibly not unique) set of grids; propagation applies every forced
 * deduction; probing hypothesizes a state for one unknown cell and keeps it
 * when the opposite hypothesis contradicts. Solution counting drives the
 * uniqueness guarantee of generated puzzles.
 *
 * Pure JS, no `node:*` — the browser overlay loads this module.
 *
 * @module
 */

import { deduceLine } from './lines.js';

/**
 * @typedef {object} Clues
 * @property {number[][]} rowClues Per row, left to right.
 * @property {number[][]} colClues Per column, top to bottom.
 */

/**
 * @typedef {object} SolveResult
 * @property {boolean} ok False on contradiction.
 * @property {boolean} solved True when no cell is unknown.
 * @property {Uint8Array} cells The grid, row-major.
 */

/**
 * @param {number} rows
 * @param {number} cols
 * @returns {Uint8Array} All-unknown grid.
 */
export function blankGrid(rows, cols) {
  return new Uint8Array(rows * cols);
}

/**
 * Propagate forced deductions from the given lines until a fixpoint. Starts
 * from `queue` (line indices: 0..rows-1 for rows, rows+i for columns) or
 * from every line when `queue` is null. Mutates `cells` in place; returns
 * whether a contradiction was hit.
 *
 * @param {Clues} clues
 * @param {number} rows
 * @param {number} cols
 * @param {Uint8Array} cells Mutated in place.
 * @param {number[] | null} [queue] Initial dirty lines (row i = i, column j =
 *   rows + j), or null for every line. A local queue reaches the same
 *   fixpoint as a full queue, because every line a deduction touches is
 *   re-queued.
 * @returns {boolean} True when consistent (fixpoint reached).
 */
export function propagate(clues, rows, cols, cells, queue = null) {
  /** @type {number[]} */
  const dirty = queue === null ? [] : [...queue];
  if (queue === null) {
    for (let i = 0; i < rows + cols; i++) dirty.push(i);
  }
  /** @type {Uint8Array} */
  const inQueue = new Uint8Array(rows + cols);
  for (const line of dirty) inQueue[line] = 1;
  let head = 0;
  while (head < dirty.length) {
    const line = dirty[head++];
    inQueue[line] = 0;
    const isRow = line < rows;
    const index = isRow ? line : line - rows;
    const lineCells = new Uint8Array(isRow ? cols : rows);
    for (let i = 0; i < lineCells.length; i++) {
      lineCells[i] = isRow ? cells[index * cols + i] : cells[i * cols + index];
    }
    const clue = isRow ? clues.rowClues[index] : clues.colClues[index];
    const result = deduceLine(clue, lineCells);
    if (!result.ok) return false;
    for (let i = 0; i < lineCells.length; i++) {
      const forced = result.forced[i];
      if (forced !== lineCells[i]) {
        if (isRow) cells[index * cols + i] = forced;
        else cells[i * cols + index] = forced;
        const crossLine = isRow ? rows + i : i;
        if (!inQueue[crossLine]) {
          inQueue[crossLine] = 1;
          dirty.push(crossLine);
        }
      }
    }
  }
  return true;
}

/**
 * Whether every cell of the grid is known.
 *
 * @param {Uint8Array} cells
 * @returns {boolean}
 */
function allKnown(cells) {
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 0) return false;
  }
  return true;
}

/**
 * Full line-solver fixpoint from the current grid.
 *
 * @param {Clues} clues
 * @param {number} rows
 * @param {number} cols
 * @param {Uint8Array} cells Mutated in place.
 * @returns {SolveResult}
 */
export function lineSolve(clues, rows, cols, cells) {
  const ok = propagate(clues, rows, cols, cells, null);
  return { ok, solved: ok && allKnown(cells), cells };
}

/**
 * One probing pass: for every unknown cell (row-major), test both
 * hypotheses; when exactly one contradicts, commit the other and propagate.
 * Mutates `cells`. Returns the number of cells committed this pass.
 *
 * Each hypothesis starts propagation only from the two lines crossing the
 * changed cell — a local queue reaches the same fixpoint as a full queue.
 *
 * @param {Clues} clues
 * @param {number} rows
 * @param {number} cols
 * @param {Uint8Array} cells Mutated in place.
 * @returns {number}
 */
function probePass(clues, rows, cols, cells) {
  let committed = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0) continue;
    const crossing = [Math.floor(i / cols), rows + (i % cols)];
    // Hypothesis: filled.
    let trial = Uint8Array.from(cells);
    trial[i] = 1;
    if (!propagate(clues, rows, cols, trial, crossing)) {
      cells[i] = 2;
      committed++;
      if (!propagate(clues, rows, cols, cells, crossing)) {
        return committed;
      }
      continue;
    }
    // Hypothesis: crossed.
    trial = Uint8Array.from(cells);
    trial[i] = 2;
    if (!propagate(clues, rows, cols, trial, crossing)) {
      cells[i] = 1;
      committed++;
      if (!propagate(clues, rows, cols, cells, crossing)) {
        return committed;
      }
    }
  }
  return committed;
}

/**
 * Line solver plus bounded contradiction probing: `maxPasses` probing
 * passes over the whole grid, stopping early when a pass commits nothing
 * or the grid is solved. `maxPasses: 0` degenerates to the line solver.
 *
 * @param {Clues} clues
 * @param {number} rows
 * @param {number} cols
 * @param {Uint8Array} cells Mutated in place; pass a blank grid to solve
 *   from scratch.
 * @param {number} maxPasses
 * @returns {SolveResult}
 */
export function probeSolve(clues, rows, cols, cells, maxPasses) {
  const first = lineSolve(clues, rows, cols, cells);
  if (!first.ok || first.solved) return first;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (probePass(clues, rows, cols, cells) === 0) break;
    if (!propagate(clues, rows, cols, cells, null)) {
      return { ok: false, solved: false, cells };
    }
    if (allKnown(cells)) {
      return { ok: true, solved: true, cells };
    }
  }
  return { ok: true, solved: false, cells };
}

/**
 * Count solutions consistent with the clues, up to `limit` (early exit).
 * Depth-first search with full propagation at every node; the first branch
 * cell is the first unknown cell in row-major order. `cells` is not
 * mutated.
 *
 * @param {Clues} clues
 * @param {number} rows
 * @param {number} cols
 * @param {Uint8Array} cells Starting grid (usually all-unknown).
 * @param {number} [limit] Stop once this many solutions are found.
 * @returns {number}
 */
export function countSolutions(clues, rows, cols, cells, limit = 2) {
  const work = Uint8Array.from(cells);
  if (!propagate(clues, rows, cols, work, null)) return 0;
  let branchCell = -1;
  for (let i = 0; i < work.length; i++) {
    if (work[i] === 0) {
      branchCell = i;
      break;
    }
  }
  if (branchCell === -1) return 1;
  let total = 0;
  for (const hypothesis of [1, 2]) {
    const trial = Uint8Array.from(work);
    trial[branchCell] = hypothesis;
    total += countSolutions(clues, rows, cols, trial, limit - total);
    if (total >= limit) return total;
  }
  return total;
}

/**
 * The run lengths of a '#'/'.' pattern, in Picross clue form. An all-blank
 * line yields [0].
 *
 * @param {string} pattern
 * @returns {number[]}
 */
export function clueOfPattern(pattern) {
  /** @type {number[]} */
  const runs = [];
  let current = 0;
  for (const ch of pattern) {
    if (ch === '#') {
      current++;
    } else if (current > 0) {
      runs.push(current);
      current = 0;
    }
  }
  if (current > 0) runs.push(current);
  return runs.length > 0 ? runs : [0];
}

/**
 * The clues of a whole grid: rows top to bottom, columns left to right.
 *
 * @param {string[]} grid Rows of '#'/'.'.
 * @returns {Clues}
 */
export function cluesOfGrid(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  return {
    rowClues: grid.map(clueOfPattern),
    colClues: Array.from({ length: cols }, (_, c) =>
      clueOfPattern(grid.map((row) => row[c]).join(''))
    ),
  };
}
