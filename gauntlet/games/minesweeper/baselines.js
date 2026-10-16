/**
 * Bundled Minesweeper baselines, matching the contract of the harness's
 * random agent: factories that return seeded, reproducible `Agent`s with the
 * `baseline` track. The runner reads the action from the last non-empty line
 * of the reply, so replies are one canonical action each.
 *
 * - `createDeductionAgent` — the no-guess guarantee made flesh: plays only
 *   cells the deduction solver proves safe. It clears every solvable board
 *   from the opening onward unless the view ever stalls (not expected on
 *   generated boards), in which case it falls back to a seeded legal move
 *   rather than aborting the episode.
 * - `createProbabilityAgent` — the strongest inference the solver offers:
 *   proven-safe cells when deduction yields any, otherwise the hidden cell
 *   with the lowest exact mine probability from frontier enumeration, with
 *   seeded tie-breaks. It flags the cells it proves are mines so chord-style
 *   flag bookkeeping stays consistent, but reveals nothing extra.
 *
 * No `node:*` imports; all randomness flows from the episode seed.
 *
 * @module
 */

import { streamFromSeed } from '../../core/rng.js';
import {
  FLAG,
  HIDDEN,
  logicalPass,
  mineProbabilities,
  neighborLists,
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
 * @typedef {object} MinesweeperViewData
 * @property {number} rows
 * @property {number} cols
 * @property {boolean} wrap
 * @property {number} minesTotal
 * @property {number} minesRemaining
 * @property {number} revealedSafe
 * @property {number} totalSafe
 * @property {'playing' | 'won' | 'lost'} status
 * @property {number[]} view
 */

/**
 * @param {Observation} observation
 * @returns {MinesweeperViewData}
 */
function dataOf(observation) {
  return /** @type {MinesweeperViewData} */ (observation.data);
}

/**
 * Pick a uniformly random element with a seeded stream.
 *
 * @template T
 * @param {T[]} items
 * @param {string} streamKey
 * @returns {T | undefined}
 */
function seededPick(items, streamKey) {
  if (items.length === 0) return undefined;
  const stream = streamFromSeed(streamKey);
  return items[stream.nextInt(0, items.length - 1)];
}

/**
 * The deduction baseline: every move is a revealed-count consequence the
 * solver can prove. When the solver proves mines, they are flagged first so
 * the board's flag bookkeeping matches its beliefs; when it proves safe
 * cells, the first (leftmost, topmost) one is revealed — the order is
 * deterministic and the guarantee means order cannot cost the game.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createDeductionAgent({ episodeSeed, id = 'minesweeper-deduction', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createDeductionAgent: episodeSeed is required');
  }
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`deduction agent "${id}" was asked to act on a finished episode`);
      }
      const neighbors = neighborLists(data.rows, data.cols, data.wrap);
      const { safe, mines } = logicalPass(data.view, neighbors, data.minesTotal);
      if (mines.length > 0) {
        const flagged = new Set(
          data.view
            .map((v, i) => (v === FLAG ? i : -1))
            .filter((i) => i >= 0)
        );
        const target = mines.find((m) => !flagged.has(m));
        if (target !== undefined) {
          const r = Math.floor(target / data.cols);
          const c = target % data.cols;
          return { text: `flag ${r} ${c}` };
        }
      }
      const provable = safe.filter((s) => data.view[s] === HIDDEN);
      if (provable.length > 0) {
        const target = provable[0];
        return { text: `reveal ${Math.floor(target / data.cols)} ${target % data.cols}` };
      }
      // Stall fallback: not expected on no-guess boards, but a baseline must
      // always answer. Seeded random over the legal actions, documented in
      // the module header.
      const fallback = seededPick(
        ctx.legalActions ?? [],
        `${episodeSeed}/${id}/${ctx.turn}/stall`
      );
      if (fallback === undefined) {
        throw new Error(`deduction agent "${id}" found no legal actions on a live board`);
      }
      return { text: fallback };
    },
  };
}

/**
 * The probability baseline: strongest information per move. Each turn it
 * runs frontier enumeration for exact per-cell mine probabilities; among
 * hidden cells it reveals the lowest-probability one, breaking ties by cell
 * index (deterministic). Proven-safe cells are taken free of charge before
 * any probability is consulted.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createProbabilityAgent({ episodeSeed, id = 'minesweeper-probability', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createProbabilityAgent: episodeSeed is required');
  }
  return {
    id,
    track,
    async act(ctx) {
      const data = dataOf(ctx.observation);
      if (data.status !== 'playing') {
        throw new Error(`probability agent "${id}" was asked to act on a finished episode`);
      }
      const neighbors = neighborLists(data.rows, data.cols, data.wrap);
      const { safe, mines } = logicalPass(data.view, neighbors, data.minesTotal);
      const flagged = new Set(
        data.view.map((v, i) => (v === FLAG ? i : -1)).filter((i) => i >= 0)
      );
      const unflaggedMine = mines.find((m) => !flagged.has(m));
      if (unflaggedMine !== undefined) {
        return { text: `flag ${Math.floor(unflaggedMine / data.cols)} ${unflaggedMine % data.cols}` };
      }
      const provable = safe.filter((s) => data.view[s] === HIDDEN);
      if (provable.length > 0) {
        const target = provable[0];
        return { text: `reveal ${Math.floor(target / data.cols)} ${target % data.cols}` };
      }
      const hidden = [];
      for (let i = 0; i < data.view.length; i++) {
        if (data.view[i] === HIDDEN) hidden.push(i);
      }
      if (hidden.length === 0) {
        const fallback = seededPick(
          ctx.legalActions ?? [],
          `${episodeSeed}/${id}/${ctx.turn}/nofrontier`
        );
        if (fallback === undefined) {
          throw new Error(`probability agent "${id}" found no legal actions on a live board`);
        }
        return { text: fallback };
      }
      const { probabilities } = mineProbabilities(data.view, neighbors, data.minesTotal);
      if (!probabilities) {
        // Inconsistent view (should not happen in legal play): seeded random.
        const fallback = seededPick(
          ctx.legalActions ?? [],
          `${episodeSeed}/${id}/${ctx.turn}/inconsistent`
        );
        if (fallback === undefined) {
          throw new Error(`probability agent "${id}" found no legal actions on a live board`);
        }
        return { text: fallback };
      }
      let best = /** @type {number | undefined} */ (undefined);
      let bestP = Number.POSITIVE_INFINITY;
      for (const cell of hidden) {
        const p = /** @type {number} */ (probabilities.get(cell));
        if (p < bestP) {
          bestP = p;
          best = cell;
        }
      }
      if (best === undefined) {
        const fallback = seededPick(
          ctx.legalActions ?? [],
          `${episodeSeed}/${id}/${ctx.turn}/unscored`
        );
        if (fallback === undefined) {
          throw new Error(`probability agent "${id}" found no legal actions on a live board`);
        }
        return { text: fallback };
      }
      return { text: `reveal ${Math.floor(best / data.cols)} ${best % data.cols}` };
    },
  };
}

export default { createDeductionAgent, createProbabilityAgent };
