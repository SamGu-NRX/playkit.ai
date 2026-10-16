/**
 * Baseline agents for Othello: a greedy heuristic (take a corner, never
 * hand the opponent one, otherwise maximize flipped discs plus square value)
 * and the game's negamax engine at a fixed node budget. Deterministic: no
 * randomness, no clocks. Both read the game state from the observation
 * payload and answer with a canonical square name like "d3", or "pass".
 *
 * @module
 */

import { legalPlacements, flipsBB, popcount2, applyPlacement } from './rules.js';
import { chooseMove } from './engine.js';
import { nextInt, nextUint32, rngFromSeed } from '../../core/rng.js';

/** @import { Agent } from '../../core/types.js' */
/** @import { TurnContext } from '../../core/types.js' */
/** @import { OthelloState as State } from './rules.js' */

/** Corner squares by name, for the greedy heuristic's first rule. */
const CORNER_NAMES = ['a1', 'h1', 'a8', 'h8'];

/**
 * Static square value, same table as the engine's, for greedy tie-breaks.
 * Row-major from rank 1 (top); symmetric, so orientation is irrelevant.
 */
const WEIGHTS = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, -1, -1, -1, -1, -2, 10,
  5, -2, -1, 0, 0, -1, -2, 5,
  5, -2, -1, 0, 0, -1, -2, 5,
  10, -2, -1, -1, -1, -1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
];

/**
 * The mover's limbs for `seat` from a state.
 *
 * @param {import('./rules.js').OthelloState} state
 * @param {number} seat
 */
function limbsOf(state, seat) {
  return { mA: state.bb[seat * 2], mB: state.bb[seat * 2 + 1], oA: state.bb[(1 - seat) * 2], oB: state.bb[(1 - seat) * 2 + 1] };
}

/**
 * The greedy baseline.
 *
 * @returns {Agent}
 */
export function createGreedyAgent() {
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const state = /** @type {State} */ (ctx.observation.data);
      if (state.status !== 'playing') {
        throw new Error('greedy agent asked to move in a finished game');
      }
      const legal = legalPlacements(state, state.toMove);
      if (legal.length === 0) {
        return { text: 'pass' };
      }
      const seat = state.toMove;
      const { mA, mB, oA, oB } = limbsOf(state, seat);
      /** @param {string} name */
      const flips = (name) => {
        const col = name.charCodeAt(0) - 97;
        const row = Number(name[1]) - 1;
        const f = flipsBB(mA, mB, oA, oB, col, row);
        return popcount2(f.a, f.b);
      };

      // Take a corner (most flips among corners, ties by sorted order).
      const corners = legal.filter((name) => CORNER_NAMES.includes(name));
      if (corners.length > 0) {
        let best = corners[0];
        for (const name of corners) {
          if (flips(name) > flips(best)) best = name;
        }
        return { text: best };
      }

      // Never hand the opponent an immediate corner when avoidable.
      const safe = legal.filter((name) => {
        const next = applyPlacement(state, seat, name.charCodeAt(0) - 97, Number(name[1]) - 1);
        const replies = legalPlacements(next, 1 - seat);
        return !replies.some((r) => CORNER_NAMES.includes(r));
      });
      const pool = safe.length > 0 ? safe : legal;

      // Maximize flips plus the square's static value; ties by sorted order.
      let best = pool[0];
      let bestScore = -Infinity;
      for (const name of pool) {
        const value = flips(name) + WEIGHTS[(Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97)];
        if (value > bestScore) {
          bestScore = value;
          best = name;
        }
      }
      return { text: best };
    },
  };
}

/**
 * The engine baseline: the game's negamax at a fixed node budget, with
 * deterministic (static-priority) tie-breaks. Passing is handled by the
 * caller — the engine only chooses placements.
 *
 * @param {number} [nodeBudget] Default 6000.
 * @returns {Agent}
 */
export function createEngineAgent(nodeBudget = 6000) {
  return {
    id: `engine-n${nodeBudget}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const state = /** @type {State} */ (ctx.observation.data);
      if (state.status !== 'playing') {
        throw new Error('engine agent asked to move in a finished game');
      }
      const legal = legalPlacements(state, state.toMove);
      if (legal.length === 0) {
        return { text: 'pass' };
      }
      const choice = chooseMove(state, { nodeBudget });
      return { text: choice.move };
    },
  };
}

/**
 * The skill-dial agent: with probability p plays the dial's random component
 * (exactly what createRandomAgent would play on that turn) and with
 * probability 1 - p the expert (the engine baseline). The Bernoulli draw is
 * pure: `u` comes from a stream keyed by the episode seed, the dial value,
 * and the turn, so replays are exact.
 *
 * @param {{ episodeSeed: string, p: number, expert?: Agent }} options
 * @returns {Agent}
 */
export function createDialAgent({ episodeSeed, p, expert = createEngineAgent() }) {
  if (!(p >= 0 && p <= 1)) {
    throw new Error('createDialAgent: p must be in [0, 1]');
  }
  return {
    id: `dial-${expert.id}-p${Math.round(p * 100)}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const stream = rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`);
      const u = nextUint32(stream).value / 0x100000000;
      if (u < p) {
        const legal = ctx.legalActions;
        if (!legal || legal.length === 0) {
          throw new Error(`dial agent: no legal actions on turn ${ctx.turn}`);
        }
        const rstream = rngFromSeed(`${episodeSeed}/random/${ctx.turn}`);
        const pick = nextInt(rstream, 0, legal.length - 1).value;
        return { text: legal[pick] };
      }
      return expert.act(ctx);
    },
  };
}
