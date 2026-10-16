/**
 * Bundled Nonogram baseline agents. Both act on the baseline track (they read
 * `legalActions`-free observation data) and are deterministic in the episode
 * state — no randomness anywhere.
 *
 * - `greedy`: repeated single-line deduction on the current marks, preferring
 *   a whole-row action whenever a row's clue plus marks pin it to one
 *   pattern. Sound (every committed mark is forced), but on probe-tier
 *   puzzles the line solver stalls and the agent holds position with no-ops.
 * - `engine`: the same strategy running the contradiction prober to its
 *   fixpoint, which finishes every generated puzzle — the par setter on all
 *   tiers.
 *
 * No `node:*` imports.
 *
 * @module
 */

import {
  blankGrid,
  lineSolve,
  probeSolve,
} from './solver.js';

/**
 * @typedef {object} BaselineOptions
 * @property {string} episodeSeed The episode's seed string (unused; kept for
 *   registry symmetry).
 */

/**
 * @typedef {object} ObservationData
 * @property {number} rows
 * @property {number} cols
 * @property {number[][]} rowClues
 * @property {number[][]} colClues
 * @property {number[][]} marks 0 unknown, 1 filled, 2 crossed.
 * @property {string} status
 */

/**
 * @param {import('../../core/types.js').TurnContext} ctx
 * @returns {ObservationData}
 */
function dataOf(ctx) {
  return /** @type {ObservationData} */ (ctx.observation.data);
}

/**
 * Flatten the observation's marks into the solver's cell encoding.
 *
 * @param {ObservationData} data
 * @returns {Uint8Array}
 */
function flatMarks(data) {
  const cells = blankGrid(data.rows, data.cols);
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      cells[r * data.cols + c] = data.marks[r][c];
    }
  }
  return cells;
}

/**
 * One deduction step from the current marks: prefer a row whose full pattern
 * is forced (commits every cell of the row in one action), then the first
 * cell a line deduction forces filled, then the first cell it forces
 * crossed. Returns null when the deduction is already at its fixpoint.
 *
 * @param {ObservationData} data
 * @param {Uint8Array} cells The deduced grid (same shape as flatMarks).
 * @returns {string | null} The next canonical action.
 */
function nextDeductionAction(data, cells) {
  // Whole-row actions first: cheapest per committed cell.
  for (let r = 0; r < data.rows; r++) {
    let hasUnknown = false;
    let fullyDetermined = true;
    let pattern = '';
    for (let c = 0; c < data.cols; c++) {
      const solved = cells[r * data.cols + c];
      if (data.marks[r][c] === 0) hasUnknown = true;
      if (solved === 0) fullyDetermined = false;
      pattern += solved === 1 ? '#' : '.';
    }
    if (hasUnknown && fullyDetermined) {
      return `row ${r + 1} ${pattern}`;
    }
  }
  // Single-cell deductions: fills first (they advance the solution), then
  // crosses.
  for (const want of [1, 2]) {
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        if (data.marks[r][c] === 0 && cells[r * data.cols + c] === want) {
          return `${want === 1 ? 'fill' : 'cross'} ${r + 1} ${c + 1}`;
        }
      }
    }
  }
  return null;
}

/**
 * A legal holding action when the deduction stalls: clear an unknown cell,
 * which changes nothing but consumes the turn honestly.
 *
 * @param {ObservationData} data
 * @returns {string}
 */
function stallAction(data) {
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) {
      if (data.marks[r][c] === 0) return `clear ${r + 1} ${c + 1}`;
    }
  }
  return 'clear 1 1';
}

/**
 * Shared agent body.
 *
 * @param {ObservationData} data
 * @param {'greedy' | 'engine'} mode
 * @returns {string}
 */
function actOn(data, mode) {
  if (data.status !== 'playing') {
    return stallAction(data);
  }
  const clues = { rowClues: data.rowClues, colClues: data.colClues };
  const cells =
    mode === 'greedy'
      ? lineSolve(clues, data.rows, data.cols, flatMarks(data))
      : probeSolve(clues, data.rows, data.cols, flatMarks(data), 48);
  if (!cells.ok) {
    // Unreachable from sound marks; hold position rather than invent.
    return stallAction(data);
  }
  return nextDeductionAction(data, cells.cells) ?? stallAction(data);
}

/**
 * The greedy baseline: line deductions only.
 *
 * @param {BaselineOptions} _options
 * @returns {import('../../core/types.js').Agent}
 */
export function createGreedyAgent(_options = { episodeSeed: '' }) {
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      return { text: actOn(dataOf(ctx), 'greedy') };
    },
  };
}

/**
 * The engine baseline: line deductions plus bounded contradiction probing to
 * the fixpoint. Solves every generated puzzle, so it scores at or near the
 * efficiency cap on every tier.
 *
 * @param {BaselineOptions} _options
 * @returns {import('../../core/types.js').Agent}
 */
export function createEngineAgent(_options = { episodeSeed: '' }) {
  return {
    id: 'engine',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      return { text: actOn(dataOf(ctx), 'engine') };
    },
  };
}
