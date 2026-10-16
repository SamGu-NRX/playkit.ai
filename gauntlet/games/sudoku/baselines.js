/**
 * Bundled Sudoku baselines, matching the contract of the harness's random
 * agent: factories that return seeded, reproducible `Agent`s with the
 * `baseline` track. The runner reads the action from the last non-empty line
 * of the reply, so replies are one canonical action each.
 *
 * Both agents keep their per-episode memory (step counter, placement order,
 * refuted guesses) in the factory closure: one agent instance plays one
 * episode, so the memory is episode-scoped and the behavior stays
 * deterministic in the episode seed.
 *
 * - `createGreedyAgent` — places any forced cell (naked or hidden single),
 *   else guesses: among empty cells the one with the fewest local
 *   candidates, a step-seeded digit among them. It keeps no failure memory;
 *   when its wrong guesses have locally doomed the grid (no empty cell can
 *   legally hold anything), it undoes its most recent placement so the
 *   episode runs to a natural ending instead of deadlocking.
 * - `createEngineAgent` — the technique solver as an agent: plays the first
 *   cell the level-2 ladder (singles, pairs, locked candidates, X-wing,
 *   XY-wing) fills beyond the input. When the ladder stalls on a solvable
 *   grid it guesses (step-seeded); when the grid loses solvability — the
 *   generator's own solution counter proves some player entry is wrong on a
 *   unique puzzle — it records that exact guess digit as refuted for the
 *   offending cell, erases the entry whose removal restores solvability,
 *   and continues. Refuted candidates are never re-guessed, so every repair
 *   permanently shrinks the search space; erasing a correct entry is safe
 *   because the ladder re-derives it.
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
 * The engine baseline: the technique solver, plus refutation memory and
 * step-seeded guessing on stalls.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createEngineAgent({ episodeSeed, id = 'sudoku-engine', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createEngineAgent: episodeSeed is required');
  }
  /**
   * Cell indices this agent has placed, in placement order.
   * @type {number[]}
   */
  const placedStack = [];
  /** Cell index -> digits proven impossible for it by refuted guesses. */
  const refuted = /** @type {Map<number, Set<number>>} */ (new Map());
  let steps = 0;
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`engine agent "${id}" was asked to act on a finished episode`);
      }
      steps++;
      const dims = dimsOf(data);
      const result = techniqueSolve(data.cells, dims, 2);
      const forced = firstDiffPlacement(data, result);
      if (forced) {
        const [, r, c] = forced.split(' ');
        placedStack.push((Number(r) - 1) * data.size + (Number(c) - 1));
        return { text: forced };
      }
      // Stall. On a unique-solution puzzle, zero completions proves some
      // player entry is wrong. Record the refutation, erase the entry whose
      // removal restores solvability (LIFO as the fallback), and continue.
      if (result.contradiction || countSolutions(data.cells, dims, 1) === 0) {
        const entries = userEntries(data);
        if (entries.length === 0) {
          throw new Error(`engine agent "${id}" hit a contradiction with no entries to undo`);
        }
        let target = entries[entries.length - 1];
        for (const u of entries) {
          const probe = data.cells.slice();
          probe[u] = 0;
          if (countSolutions(probe, dims, 1) >= 1) {
            target = u;
            break;
          }
        }
        // The refuted digit of the offending cell is dead — record it so it
        // is never guessed again.
        const refutedForCell = refuted.get(target) ?? new Set();
        refutedForCell.add(data.cells[target]);
        refuted.set(target, refutedForCell);
        const stackAt = placedStack.indexOf(target);
        if (stackAt !== -1) placedStack.splice(stackAt, 1);
        return { text: `erase ${rowCol(data, target)}` };
      }
      // Solvable stall: guess. Candidates exclude refuted digits; the most
      // constrained surviving cell goes first. If exactly one candidate
      // survives refutation anywhere, that cell is now forced.
      const cand = localCandidates(data);
      let best = -1;
      let bestDigits = /** @type {number[]} */ ([]);
      let bestCount = data.size + 1;
      for (let i = 0; i < cand.length; i++) {
        if (data.cells[i]) continue;
        const survived = bitsToDigits(cand[i], dims).filter(
          (d) => !refuted.get(i)?.has(d)
        );
        if (survived.length === 0) continue;
        if (survived.length < bestCount) {
          bestCount = survived.length;
          best = i;
          bestDigits = survived;
          if (survived.length === 1) break;
        }
      }
      if (best === -1) {
        // Every empty cell is refuted or blocked: the grid is doomed.
        // Undo the most recent placement and continue.
        if (placedStack.length === 0) {
          throw new Error(`engine agent "${id}" found no legal move`);
        }
        const top = /** @type {number} */ (placedStack.pop());
        return { text: `erase ${rowCol(data, top)}` };
      }
      const digit = pickDigit(bestDigits, best, episodeSeed, id, steps);
      placedStack.push(best);
      return { text: `place ${rowCol(data, best)} ${digit}` };
    },
  };
}

export default { createGreedyAgent, createEngineAgent };
