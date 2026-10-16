/**
 * Seeded Nonogram puzzle generation.
 *
 * Candidates are random Bernoulli grids from the episode RNG stream; a
 * candidate is accepted only when it meets its tier's solver grade:
 *
 * - line-solvable tiers: the repeated single-line deduction alone solves the
 *   puzzle from the clues. A line solver that determines every cell proves
 *   uniqueness — each deduction is forced in every clue-consistent grid, so
 *   exactly one grid survives.
 * - probe tier (`lineSolvable: false`): the line solver must NOT finish and
 *   an exhaustive solution count must be exactly 1 — unique, but only
 *   probing (or deeper search) gets you there.
 *
 * Rejection sampling until acceptance keeps the whole thing deterministic in
 * the seed: the same (shape, density, grade, seed) always yields the same
 * puzzle.
 *
 * Pure JS, no `node:*` — the browser overlay loads this module.
 *
 * @module
 */

import { nextFloat, rngFromSeed } from '../../core/rng.js';
import {
  blankGrid,
  cluesOfGrid,
  countSolutions,
  lineSolve,
} from './solver.js';

/**
 * @typedef {object} Puzzle
 * @property {number[][]} rowClues Per row, left to right.
 * @property {number[][]} colClues Per column, top to bottom.
 * @property {string[]} solution Rows of '#'/'.'; never observed by agents.
 * @property {number} par Filled cells in the solution (the efficiency par).
 */

/**
 * Safety valve: candidates tried per episode before giving up. The measured
 * acceptance rates (see the PR) are far above 1/5000 on every tier.
 *
 * @type {number}
 */
export const MAX_CANDIDATES = 5000;

/**
 * @typedef {object} GenerateOptions
 * @property {number} rows
 * @property {number} cols
 * @property {number} density Bernoulli fill probability for candidates.
 * @property {boolean} lineSolvable True for line-solver-graded tiers.
 * @property {string} seed Episode seed.
 */

/**
 * @param {Uint8Array} cells
 * @param {number} cols
 * @returns {string[]}
 */
function gridStrings(cells, cols) {
  /** @type {string[]} */
  const rows = [];
  for (let r = 0; r < cells.length / cols; r++) {
    let row = '';
    for (let c = 0; c < cols; c++) {
      row += cells[r * cols + c] === 1 ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Generate the puzzle for one episode. Deterministic in every argument;
 * repeated calls return equal (not shared) results.
 *
 * @param {GenerateOptions} options
 * @returns {Puzzle}
 * @throws {Error} when no candidate within MAX_CANDIDATES meets the grade.
 */
export function generatePuzzle({ rows, cols, density, lineSolvable, seed }) {
  for (let candidate = 0; candidate < MAX_CANDIDATES; candidate++) {
    let state = rngFromSeed(`${seed}/puzzle/${candidate}`);
    const cells = blankGrid(rows, cols);
    for (let i = 0; i < cells.length; i++) {
      const draw = nextFloat(state);
      cells[i] = draw.value < density ? 1 : 0;
      state = draw.state;
    }
    const solution = gridStrings(cells, cols);
    const clues = cluesOfGrid(solution);
    const par = solution.join('').split('#').length - 1;
    if (par === 0 || par === rows * cols) continue; // degenerate grids
    const grade = lineSolve(clues, rows, cols, blankGrid(rows, cols));
    if (lineSolvable) {
      if (grade.ok && grade.solved) {
        return { rowClues: clues.rowClues, colClues: clues.colClues, solution, par };
      }
      continue;
    }
    if (grade.ok && grade.solved) continue; // belongs on a line tier
    if (countSolutions(clues, rows, cols, blankGrid(rows, cols), 2) === 1) {
      return { rowClues: clues.rowClues, colClues: clues.colClues, solution, par };
    }
  }
  throw new Error(
    `generatePuzzle: no candidate met the ${lineSolvable ? 'line-solvable' : 'probe'} grade within ${MAX_CANDIDATES} tries (seed ${JSON.stringify(seed)})`
  );
}

/**
 * Bounded cache of generated puzzles: `reset` and the baselines solve the
 * same (tier, seed) repeatedly within one process, and regeneration is the
 * expensive path. Keys are the full generation argument set, so entries are
 * transparent — a cache hit equals a fresh generation.
 *
 * @type {Map<string, Puzzle>}
 */
const PUZZLE_CACHE = new Map();

const PUZZLE_CACHE_LIMIT = 64;

/**
 * Cached wrapper around `generatePuzzle`.
 *
 * @param {GenerateOptions} options
 * @returns {Puzzle}
 */
export function puzzleFor(options) {
  const key = `${options.rows}x${options.cols}|${options.density}|${options.lineSolvable ? 1 : 0}|${options.seed}`;
  const hit = PUZZLE_CACHE.get(key);
  if (hit) {
    return {
      rowClues: hit.rowClues.map((row) => [...row]),
      colClues: hit.colClues.map((col) => [...col]),
      solution: [...hit.solution],
      par: hit.par,
    };
  }
  const fresh = generatePuzzle(options);
  if (PUZZLE_CACHE.size >= PUZZLE_CACHE_LIMIT) {
    const oldest = PUZZLE_CACHE.keys().next().value;
    if (oldest !== undefined) PUZZLE_CACHE.delete(oldest);
  }
  PUZZLE_CACHE.set(key, fresh);
  return {
    rowClues: fresh.rowClues.map((row) => [...row]),
    colClues: fresh.colClues.map((col) => [...col]),
    solution: [...fresh.solution],
    par: fresh.par,
  };
}
