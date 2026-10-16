/**
 * Bundled Sudoku baselines, matching the contract of the harness's random
 * agent: factories that return seeded, reproducible `Agent`s with the
 * `baseline` track. The runner reads the action from the last non-empty line
 * of the reply, so replies are one canonical action each.
 *
 * The greedy agent keeps its per-episode memory (step counter, placement
 * order) in the factory closure: one agent instance plays one episode, so
 * the memory is episode-scoped and the behavior stays deterministic in the
 * episode seed.
 *
 * - `createGreedyAgent` — places any forced cell (naked or hidden single),
 *   else guesses: among empty cells the one with the fewest local
 *   candidates, a step-seeded digit among them. It keeps no failure memory;
 *   when its wrong guesses have locally doomed the grid (no empty cell can
 *   legally hold anything), it undoes its most recent placement so the
 *   episode runs to a natural ending instead of deadlocking.
 * - `createEngineAgent` — the ceiling: it solves the puzzle privately with
 *   the packet's own candidate machinery (MRV backtracking over
 *   `computeCandidates`), then places only correct digits — one action per
 *   empty cell, never a guess, never an erasure — so it lands exactly at par
 *   on every tier. Every puzzle this game emits is unique-solution, so the
 *   private completion IS the solution; a completion of a (never-emitted)
 *   multi-solution grid would be scored honestly as 'stuck'. The episode
 *   seed is accepted for factory-signature parity and is otherwise unused:
 *   determinism needs no randomness here.
 *
 * No `node:*` imports; all randomness flows from the episode seed.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  bitsToDigits,
  computeCandidates,
  popcount,
  techniqueSolve,
} from './solver.js';

/** @import { Agent, Observation } from '../../core/types.js' */

/**
 * @typedef {object} BaselineOptions
 * @property {string} episodeSeed The episode's seed string.
 * @property {string} [id] Override the agent id.
 * @property {'baseline' | 'community'} [track] Default "baseline".
 */

/**
 * The observation's `data` view, as the game emits it.
 *
 * @typedef {object} SudokuViewData
 * @property {number} size
 * @property {number} boxRows
 * @property {number} boxCols
 * @property {number[]} givens
 * @property {number[]} cells
 * @property {number} emptyCells
 * @property {'playing' | 'solved' | 'stuck'} status
 */

/**
 * @param {Observation} observation
 * @returns {SudokuViewData}
 */
function dataOf(observation) {
  return /** @type {SudokuViewData} */ (observation.data);
}

/** @param {SudokuViewData} data @returns {import('./solver.js').Dims} */
function dimsOf(data) {
  return { size: data.size, boxRows: data.boxRows, boxCols: data.boxCols };
}

/** @param {SudokuViewData} data @param {number} i @returns {string} */
function rowCol(data, i) {
  return `${Math.floor(i / data.size) + 1} ${(i % data.size) + 1}`;
}

/**
 * The first cell the solver filled that was empty on the agent's grid, as a
 * canonical place action.
 *
 * @param {SudokuViewData} data
 * @param {import('./solver.js').SolveResult} result
 * @returns {string | null}
 */
function firstDiffPlacement(data, result) {
  for (const i of result.placed) {
    if (!data.cells[i]) {
      return `place ${rowCol(data, i)} ${result.cells[i]}`;
    }
  }
  return null;
}

/**
 * Local candidate masks straight from the observed grid.
 *
 * @param {SudokuViewData} data
 * @returns {number[]}
 */
function localCandidates(data) {
  return computeCandidates(data.cells, dimsOf(data));
}

/**
 * Indices of the player's own entries (not givens), ascending.
 *
 * @param {SudokuViewData} data
 * @returns {number[]}
 */
function userEntries(data) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < data.cells.length; i++) {
    if (data.cells[i] && !data.givens[i]) out.push(i);
  }
  return out;
}

/**
 * Seeded digit pick among `digits` for `cell` at agent step `step`.
 *
 * @param {number[]} digits
 * @param {number} cell
 * @param {string} episodeSeed
 * @param {string} agentId
 * @param {number} step
 * @returns {number}
 */
function pickDigit(digits, cell, episodeSeed, agentId, step) {
  if (digits.length === 1) return digits[0];
  const pick = nextInt(
    rngFromSeed(`${episodeSeed}/${agentId}/guess/${step}/${cell}`),
    0,
    digits.length - 1
  ).value;
  return digits[pick];
}

/**
 * The greedy baseline: forced cells (naked or hidden singles), else guess;
 * LIFO undo when the grid is locally doomed.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createGreedyAgent({ episodeSeed, id = 'sudoku-greedy', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createGreedyAgent: episodeSeed is required');
  }
  /**
   * Cell indices this agent has placed, in placement order.
   * @type {number[]}
   */
  const placedStack = [];
  let steps = 0;
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`greedy agent "${id}" was asked to act on a finished episode`);
      }
      steps++;
      const forced = firstDiffPlacement(
        data,
        techniqueSolve(data.cells, dimsOf(data), 0)
      );
      if (forced) {
        placedStack.push(Number(forced.split(' ')[1]) * data.size + Number(forced.split(' ')[2]) - data.size - 1);
        return { text: forced };
      }
      const cand = localCandidates(data);
      let best = -1;
      let bestCount = data.size + 1;
      for (let i = 0; i < cand.length; i++) {
        if (data.cells[i]) continue;
        const count = popcount(cand[i]);
        if (count === 0) continue;
        if (count < bestCount) {
          bestCount = count;
          best = i;
        }
      }
      if (best !== -1) {
        const digit = pickDigit(
          bitsToDigits(cand[best], dimsOf(data)),
          best,
          episodeSeed,
          id,
          steps
        );
        placedStack.push(best);
        return { text: `place ${rowCol(data, best)} ${digit}` };
      }
      // No empty cell can legally hold anything: undo the most recent
      // placement so the episode can continue.
      if (placedStack.length === 0) {
        throw new Error(`greedy agent "${id}" found no legal move`);
      }
      const top = /** @type {number} */ (placedStack.pop());
      return { text: `erase ${rowCol(data, top)}` };
    },
  };
}
/**
 * A private complete solve of the observed grid: MRV backtracking over the
 * packet's own candidate masks. Every puzzle this game emits is
 * unique-solution, so the completion this finds IS the solution; a
 * (never-emitted) multi-solution grid would complete to the first
 * search-order solution and be scored honestly as 'stuck'.
 *
 * @param {number[]} cells
 * @param {import('./solver.js').Dims} dims
 * @returns {number[]}
 */
function privateSolution(cells, dims) {
  const work = cells.slice();
  const n = dims.size * dims.size;
  /** @returns {boolean} */
  const fill = () => {
    const cand = computeCandidates(work, dims);
    let best = -1;
    let bestCount = dims.size + 1;
    for (let i = 0; i < n; i++) {
      if (work[i]) continue;
      const count = popcount(cand[i]);
      if (count === 0) return false;
      if (count < bestCount) {
        bestCount = count;
        best = i;
        if (count === 1) break;
      }
    }
    if (best === -1) return true;
    for (const digit of bitsToDigits(cand[best], dims)) {
      work[best] = digit;
      if (fill()) return true;
      work[best] = 0;
    }
    return false;
  };
  if (!fill()) {
    throw new Error('sudoku engine: the observed grid admits no completion');
  }
  return work;
}

/**
 * The engine baseline: the tier ladder's ceiling. It solves the puzzle
 * privately with the packet's own candidate machinery, then places only
 * correct digits — one action per empty cell, never a guess, never an
 * erasure — so it lands exactly at par on every tier. The episode seed is
 * accepted for factory-signature parity and is otherwise unused: being
 * deterministic needs no randomness here.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createEngineAgent({ episodeSeed, id = 'sudoku-engine', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createEngineAgent: episodeSeed is required');
  }
  /** Cached private solution of the episode's puzzle. @type {number[] | null} */
  let solution = null;
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`engine agent "${id}" was asked to act on a finished episode`);
      }
      if (!solution) {
        solution = privateSolution(data.cells, dimsOf(data));
      }
      for (let i = 0; i < data.cells.length; i++) {
        if (!data.cells[i]) {
          return { text: `place ${rowCol(data, i)} ${solution[i]}` };
        }
      }
      throw new Error(`engine agent "${id}" found no empty cell on a playing grid`);
    },
  };
}

export default { createGreedyAgent, createEngineAgent };
