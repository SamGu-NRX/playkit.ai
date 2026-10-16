/**
 * Bundled cube baseline agents. Both act on the baseline track and are
 * deterministic in the episode seed.
 *
 * - `engine`: solves the scramble once with the meet-in-the-middle solver and
 *   replays one optimal line, so it scores exactly 1.0 on every seed.
 * - `greedy`: the one-ply turn that most increases the number of facelets
 *   matching their face's centre colour, with ties broken by the seeded core
 *   RNG. It is short-sighted and wanders; reported per tier in the tests.
 *
 * No `node:*` imports; every random choice comes from the core RNG seeded by
 * the episode seed.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../../core/rng.js';
import { CANONICAL_MOVES, applyMove, stickerMatchCount } from './cube.js';
import { solveOptimal } from './solver.js';

/** @import { Agent } from '../../core/types.js' */

/**
 * Baseline options.
 * @typedef {object} BaselineOptions
 * @property {string} episodeSeed The episode's seed string.
 */

/**
 * The engine baseline: replay one optimal line. The line is solved from the
 * first observation's facelets (the reset state) and every later turn reads
 * the next move by turn index; if the state ever left the planned line it
 * re-solves from the current facelets.
 *
 * @param {BaselineOptions} [_options]
 * @returns {Agent}
 */
export function createEngineAgent(_options = { episodeSeed: '' }) {
  /** @type {string[] | null} */
  let plan = null;
  let planTurn = 0;
  return {
    id: 'cube-engine',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {import('../../core/types.js').TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const data = /** @type {{ facelets: string }} */ (ctx.observation.data);
      if (plan === null || ctx.turn < planTurn) {
        plan = solveOptimal(data.facelets).solution;
        planTurn = ctx.turn;
        return { text: plan[0] };
      }
      const move = plan[ctx.turn - planTurn];
      if (move === undefined) {
        plan = solveOptimal(data.facelets).solution;
        planTurn = ctx.turn;
        return { text: /** @type {string} */ (plan[0]) };
      }
      return { text: move };
    },
  };
}

/**
 * The greedy baseline: the one-ply turn that most increases the count of
 * facelets matching their face's centre colour, ties broken by the seeded
 * RNG (stream `<episodeSeed>/greedy/turn<turn>`).
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createGreedyAgent(options) {
  if (typeof options.episodeSeed !== 'string' || options.episodeSeed.length === 0) {
    throw new Error('createGreedyAgent: episodeSeed is required');
  }
  const { episodeSeed } = options;
  return {
    id: 'cube-greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {import('../../core/types.js').TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const data = /** @type {{ facelets: string }} */ (ctx.observation.data);
      let best = -1;
      /** @type {string[]} */
      const bestMoves = [];
      for (const move of CANONICAL_MOVES) {
        const matches = stickerMatchCount(applyMove(data.facelets, move));
        if (matches > best) {
          best = matches;
          bestMoves.length = 0;
          bestMoves.push(move);
        } else if (matches === best) {
          bestMoves.push(move);
        }
      }
      const pick = nextInt(
        rngFromSeed(`${episodeSeed}/greedy/turn${ctx.turn}`),
        0,
        bestMoves.length - 1
      ).value;
      return { text: bestMoves[pick] };
    },
  };
}
