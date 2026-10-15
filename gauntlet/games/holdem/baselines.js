/**
 * Baseline agents for the hold'em game, for headless evaluation runs.
 * `greedy`: raise the top ~20% of preflop hands (Chen score) and any made
 * pair or better postflop, otherwise call/check, never fold. `engine`: the
 * equity bot's policy (Monte Carlo equity against a uniform range). Both are
 * deterministic given the episode seed. No `node:*` imports.
 *
 * @module
 */

import { evaluate } from './evaluator.js';
import { streamFromSeed } from '../../core/rng.js';
import { chenScore } from './strength.js';
import { EQUITY_SAMPLES, equityPolicy, monteCarloEquity } from './opponents.js';

/** @import { Agent } from '../../core/types.js' */

/** @import { HoldemData } from './opponents.js' */

/** Chen score at or above which greedy raises preflop (≈ top 18% of hands). */
export const GREEDY_PREFLOP_RAISE = 8;

/**
 * @param {HoldemData} data
 * @returns {'fold' | 'call' | 'raise'}
 */
function greedyAction(data) {
  if (data.street === 0) {
    if (data.canRaise && chenScore(data.hole) >= GREEDY_PREFLOP_RAISE) return 'raise';
    return 'call';
  }
  const made = evaluate([...data.hole, ...data.board]);
  if (data.canRaise && made.category >= 1) return 'raise';
  return 'call';
}

/**
 * @param {HoldemData} data
 * @param {string} streamKey
 * @returns {'fold' | 'call' | 'raise'}
 */
function engineAction(data, streamKey) {
  const stream = streamFromSeed(streamKey);
  const equity = monteCarloEquity(data.hole, data.board, 5, EQUITY_SAMPLES, stream);
  return equityPolicy(data, equity);
}

/**
 * Build a baseline agent.
 *
 * @param {'greedy' | 'engine'} kind
 * @param {string} seed Episode seed (used to seed the engine baseline's
 *   Monte Carlo streams; greedy needs no randomness).
 * @param {number} seat The baseline's seat (part of the stream key).
 * @returns {Agent}
 */
export function makeBaseline(kind, seed, seat) {
  return {
    id: `holdem-${kind}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const data = /** @type {HoldemData} */ (ctx.observation.data);
      const action =
        kind === 'greedy'
          ? greedyAction(data)
          : engineAction(
              data,
              `${ctx.tier.id}/${seed}/baseline/${seat}/hand${data.handIndex}/street${data.street}/bets${data.raises}/decision${ctx.turn}`
            );
      if (action === 'raise' && !data.canRaise) return { text: 'call' };
      return { text: action };
    },
  };
}
