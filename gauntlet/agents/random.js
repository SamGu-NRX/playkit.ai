/**
 * The bundled baseline random agent: uniform over `legalActions`, seeded from
 * the episode seed and the agent id so runs are reproducible. No `node:*`.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../core/rng.js';

/** @import { Agent } from '../core/types.js' */

/**
 * @typedef {object} RandomAgentOptions
 * @property {string} episodeSeed The episode's seed string.
 * @property {string} [id] Default "random".
 * @property {'baseline' | 'community'} [track] Default "baseline".
 */

/**
 * Build a random agent for one episode. Each attempt derives an independent
 * stream from `<episodeSeed>/<id>/<turn>`, so a replayed episode with the
 * same seed draws the same moves even if earlier attempts were invalid.
 *
 * @param {RandomAgentOptions} options
 * @returns {Agent}
 */
export function createRandomAgent({ episodeSeed, id = 'random', track = 'baseline' }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createRandomAgent: episodeSeed is required');
  }
  return {
    id,
    track,
    async act(ctx) {
      const legal = ctx.legalActions;
      if (!legal || legal.length === 0) {
        throw new Error(
          `random agent "${id}" received no legal actions; random play needs the baseline track`
        );
      }
      const state = rngFromSeed(`${episodeSeed}/${id}/${ctx.turn}`);
      const pick = nextInt(state, 0, legal.length - 1).value;
      return { text: legal[pick] };
    },
  };
}
