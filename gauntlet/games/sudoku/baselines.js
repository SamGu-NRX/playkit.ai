/**
 * Bundled Sudoku baselines, matching the contract of the harness's random
 * agent: factories that return seeded, reproducible `Agent`s with the
 * `baseline` track. The runner reads the action from the last non-empty line
 * of the reply, so replies are one canonical action each.
 *
 * - `createGreedyAgent` — places any forced cell (naked or hidden single),
 *   else guesses: among empty cells the one with the fewest candidates, a
 *   seeded digit among them. No repair: guesses stay guessed.
 * - `createEngineAgent` — the technique solver as an agent: plays the first
 *   cell the level-2 ladder (singles, pairs, locked candidates, X-wing,
 *   XY-wing) fills beyond the input. When the ladder stalls, it first checks
 *   whether the grid still extends to any solution (the same solution
 *   counter the generator uses — with a unique-solution puzzle, zero
 *   completions proves some player entry is wrong) and if so erases the
 *   entry whose removal restores solvability; only on a still-solvable
 *   stall does it guess, seeded per turn. Because it repairs its own wrong
 *   guesses, the hard tier — whose puzzles sit beyond the ladder — is not
 *   solved every time.
 *
 * No `node:*` imports; all randomness flows from the episode seed.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  bitsToDigits,
  computeCandidates,
  countSolutions,
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
 * Seeded guess in the most constrained empty cell (fewest candidates,
 * lowest index on ties).
 *
 * @param {SudokuViewData} data
 * @param {string} episodeSeed
 * @param {string} agentId
 * @param {number} turn
 * @returns {string | null}
 */
function guessAction(data, episodeSeed, agentId, turn) {
  const dims = dimsOf(data);
  const cand = computeCandidates(data.cells, dims);
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
  if (best === -1) return null;
  const digits = bitsToDigits(cand[best], dims);
  const pick = nextInt(
    rngFromSeed(`${episodeSeed}/${agentId}/guess/${turn}`),
    0,
    digits.length - 1
  ).value;
  return `place ${rowCol(data, best)} ${digits[pick]}`;
}

/**
 * The greedy baseline: forced cells (naked or hidden singles), else guess.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createGreedyAgent({ episodeSeed, id = 'sudoku-greedy', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createGreedyAgent: episodeSeed is required');
  }
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`greedy agent "${id}" was asked to act on a finished episode`);
      }
      const forced = firstDiffPlacement(
        data,
        techniqueSolve(data.cells, dimsOf(data), 0)
      );
      if (forced) return { text: forced };
      const guess = guessAction(data, episodeSeed, id, ctx.turn);
      if (guess) return { text: guess };
      throw new Error(`greedy agent "${id}" found no legal move`);
    },
  };
}

/**
 * The engine baseline: the technique solver, plus honest repair and seeded
 * guessing on stalls.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createEngineAgent({ episodeSeed, id = 'sudoku-engine', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createEngineAgent: episodeSeed is required');
  }
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`engine agent "${id}" was asked to act on a finished episode`);
      }
      const dims = dimsOf(data);
      const result = techniqueSolve(data.cells, dims, 2);
      const forced = firstDiffPlacement(data, result);
      if (forced) return { text: forced };
      // Stall. On a unique-solution puzzle, zero completions proves some
      // player entry is wrong; erase the entry whose removal restores
      // solvability (leftmost as the fallback when several entries are
      // wrong). Only a still-solvable stall earns a guess.
      if (result.contradiction || countSolutions(data.cells, dims, 1) === 0) {
        /** @type {number[]} */
        const userEntries = [];
        for (let i = 0; i < data.cells.length; i++) {
          if (data.cells[i] && !data.givens[i]) userEntries.push(i);
        }
        if (userEntries.length > 0) {
          let target = userEntries[0];
          for (const u of userEntries) {
            const probe = data.cells.slice();
            probe[u] = 0;
            if (countSolutions(probe, dims, 1) >= 1) {
              target = u;
              break;
            }
          }
          return { text: `erase ${rowCol(data, target)}` };
        }
      }
      const guess = guessAction(data, episodeSeed, id, ctx.turn);
      if (guess) return { text: guess };
      throw new Error(`engine agent "${id}" found no legal move`);
    },
  };
}

export default { createGreedyAgent, createEngineAgent };
