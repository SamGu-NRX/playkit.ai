/**
 * Bundled chess baseline agents: a seeded material-greedy agent and the
 * engine agent the tier ladder is built from. Both read the observation's
 * state payload and answer with a UCI move. No `node:*` imports.
 *
 * @module
 */

import { bestMove, replayUci, internals, moveToUci } from './engine.js';
import { nextInt, rngFromSeed, streamFromState } from '../../core/rng.js';

/** @import { Agent, TierSpec } from '../../core/types.js' */
/** @import { RngState } from '../../core/rng.js' */

/**
 * @typedef {object} ChessAgentState
 * @property {string} startFen
 * @property {string[]} moves
 */

/**
 * The seeded greedy baseline: takes the best immediate capture by
 * victim-minus-attacker value when one exists, otherwise plays a seeded
 * uniform pick among all legal moves. Deterministic per (episodeSeed, turn).
 *
 * @param {object} [options]
 * @param {string} [options.id] Default "greedy-baseline".
 * @param {string} [options.episodeSeed] Default "chess/greedy".
 * @returns {Agent}
 */
export function createGreedyBaselineAgent(options = {}) {
  const id = options.id ?? 'greedy-baseline';
  const episodeSeed = options.episodeSeed ?? 'chess/greedy';
  return {
    id,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('../../core/types.js').TurnContext} */ ctx) {
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) {
        throw new Error(`greedy baseline "${id}" received no legal actions`);
      }
      const state = /** @type {ChessAgentState} */ (ctx.observation.data);
      const chess = replayUci(state.startFen, state.moves);
      const moves = internals(chess)._moves({ legal: true });
      /** @type {Record<string, number>} */
      const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
      /** @type {{ uci: string, score: number } | null} */
      let bestCapture = null;
      for (const move of moves) {
        if (!move.captured) continue;
        const score = values[move.captured] - values[move.piece];
        const uci = moveToUci(move);
        if (!bestCapture || score > bestCapture.score) {
          bestCapture = { uci, score };
        }
      }
      if (bestCapture) {
        return { text: bestCapture.uci };
      }
      const pick = nextInt(rngFromSeed(`${episodeSeed}/${id}/${ctx.turn}`), 0, legal.length - 1).value;
      return { text: legal[pick] };
    },
  };
}

/**
 * The seeded random baseline for the sand tier: a uniformly random pick
 * among the legal actions, deterministic per (tier, episodeSeed, seat,
 * turn). Never plays an invalid move because it samples exactly the legal
 * list the engine hands it.
 *
 * @param {object} options
 * @param {TierSpec} options.tier Names the RNG stream (only its id).
 * @param {string} options.seed The episode seed.
 * @param {number} options.seat The opponent's seat.
 * @param {string} [options.id] Default "random-baseline".
 * @returns {Agent}
 */
export function createRandomBaselineAgent({ tier, seed, seat, id }) {
  const agentId = id ?? 'random-baseline';
  return {
    id: agentId,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('../../core/types.js').TurnContext} */ ctx) {
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) {
        throw new Error(`random baseline "${agentId}" received no legal actions`);
      }
      const rng = rngFromSeed(`${tier.id}/${seed}/opponent/${seat}/turn${ctx.turn}`);
      const pick = nextInt(rng, 0, legal.length - 1).value;
      return { text: legal[pick] };
    },
  };
}

/**
 * The engine baseline agent for one tier: reads the tier's engine params
 * (depth, nodeBudget, quiescenceMaxPlies) and breaks ties by seed.
 *
 * @param {object} options
 * @param {TierSpec} options.tier The tier whose params drive the search.
 * @param {string} options.seed The episode seed (tie-breaking).
 * @param {number} options.seat The opponent's seat.
 * @param {string} [options.id] Default from the tier id.
 * @returns {Agent}
 */
export function createEngineBaselineAgent({ tier, seed, seat, id }) {
  const params = /** @type {{ depth: number, nodeBudget: number, quiescenceMaxPlies?: number }} */ (
    tier.params
  );
  return {
    id: id ?? `engine-${tier.id}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('../../core/types.js').TurnContext} */ ctx) {
      const state = /** @type {ChessAgentState} */ (ctx.observation.data);
      const chess = replayUci(state.startFen, state.moves);
      const rng = streamFromState(/** @type {RngState} */ (
        rngFromSeed(`${tier.id}/${seed}/opponent/${seat}/turn${ctx.turn}`)
      ));
      const best = bestMove(chess, params, rng.getState());
      return { text: best.uci };
    },
  };
}
