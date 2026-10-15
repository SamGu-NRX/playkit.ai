/**
 * Bundled Mastermind baseline agents. Both act on the baseline track (they
 * read `legalActions`-free observation data) and are deterministic in the
 * episode seed.
 *
 * - `greedy`: a seeded random code drawn from the candidates consistent with
 *   all feedback so far — sound but information-blind.
 * - `engine`: the reference strategy itself (`reference.js`), the par
 *   setter, so it scores exactly 1.0 on every tier.
 *
 * No `node:*` imports; every random choice comes from the core RNG seeded by
 * the episode seed.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  allCodes,
  filterConsistent,
  referenceNextGuess,
} from './reference.js';

/** @import { Agent } from '../../core/types.js' */
/** @import { MastermindHistoryEntry } from './index.js' */

/**
 * @typedef {object} BaselineOptions
 * @property {string} episodeSeed The episode's seed string.
 */

/**
 * The guess history so far, from the observation payload.
 *
 * @param {import('../../core/types.js').TurnContext} ctx
 * @returns {{ pegs: number, colors: number, history: MastermindHistoryEntry[] }}
 */
function contextOf(ctx) {
  const params = /** @type {{ pegs: number, colors: number }} */ (ctx.tier.params);
  const data = /** @type {{ guesses?: MastermindHistoryEntry[] }} */ (ctx.observation.data);
  return {
    pegs: params.pegs,
    colors: params.colors,
    history: (data.guesses ?? []).map((entry) => ({ ...entry })),
  };
}

/**
 * The greedy baseline: a seeded random code consistent with every piece of
 * feedback received so far. Each attempt derives its stream from
 * `<episodeSeed>/greedy/turn<turn>`, so replays are exact.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createGreedyAgent({ episodeSeed }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createGreedyAgent: episodeSeed is required');
  }
  let pool = /** @type {string[] | null} */ (null);
  let poolPegs = 0;
  let poolColors = 0;
  let poolLength = 0;
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const { pegs, colors, history } = contextOf(ctx);
      // Incremental consistency filter: within one episode the history only
      // grows, so keep the pool and apply just the entries not yet applied.
      if (pool === null || pegs !== poolPegs || colors !== poolColors || history.length < poolLength) {
        pool = allCodes(pegs, colors);
        poolPegs = pegs;
        poolColors = colors;
        poolLength = 0;
      }
      while (poolLength < history.length) {
        pool = filterConsistent(pool, history[poolLength]);
        poolLength++;
      }
      if (pool.length === 0) {
        // Unreachable with correct feedback scoring; fall back to the full
        // code space rather than crash.
        pool = allCodes(pegs, colors);
        poolLength = history.length;
      }
      const state = rngFromSeed(`${episodeSeed}/greedy/turn${ctx.turn}`);
      const pick = nextInt(state, 0, pool.length - 1).value;
      return { text: `guess ${pool[pick]}` };
    },
  };
}

/**
 * The engine baseline: the reference strategy that sets par. It replays the
 * par computation exactly (same `referenceNextGuess` calls on the same
 * history), so it always solves the secret in exactly par guesses.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createEngineAgent({ episodeSeed }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createEngineAgent: episodeSeed is required');
  }
  return {
    id: 'engine',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const { pegs, colors, history } = contextOf(ctx);
      const guess = referenceNextGuess(pegs, colors, history, episodeSeed);
      return { text: `guess ${guess}` };
    },
  };
}
