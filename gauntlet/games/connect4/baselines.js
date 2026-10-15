/**
 * Baseline agents for Connect Four: a greedy heuristic (win now, else block
 * the opponent's immediate win, else the most central legal column) and a
 * depth-8 negamax engine. Deterministic: no randomness, no clocks. Both read
 * the game state from the observation payload and answer with the canonical
 * 1-based column number.
 *
 * @module
 */

import { legalCols, bitFor, hasAlignment } from './rules.js';
import { chooseMove } from './engine.js';

/** @import { Agent } from '../../core/types.js' */
/** @import { TurnContext } from '../../core/types.js' */
/** @import { Connect4State as State } from './rules.js' */

/**
 * Most central column first: distance to the center column (index 3), then
 * lower index.
 *
 * @param {number[]} cols
 * @returns {number}
 */
function mostCentral(cols) {
  let best = cols[0];
  for (const col of cols) {
    if (Math.abs(col - 3) < Math.abs(best - 3)) best = col;
  }
  return best;
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
      const me = state.toMove;
      const opponent = 1 - me;
      const cols = legalCols(state);

      // Win now.
      const winning = cols.filter((col) => {
        const bit = bitFor(col, state.heights[col]);
        return hasAlignment({
          a: state.bb[me * 2] | bit.a,
          b: state.bb[me * 2 + 1] | bit.b,
        });
      });
      if (winning.length > 0) {
        return { text: String(mostCentral(winning) + 1) };
      }

      // Block the opponent's immediate win.
      const threats = cols.filter((col) => {
        const bit = bitFor(col, state.heights[col]);
        return hasAlignment({
          a: state.bb[opponent * 2] | bit.a,
          b: state.bb[opponent * 2 + 1] | bit.b,
        });
      });
      if (threats.length > 0) {
        return { text: String(mostCentral(threats) + 1) };
      }

      // Most central legal column.
      return { text: String(mostCentral(cols) + 1) };
    },
  };
}

/**
 * The engine baseline: the same negamax the ladder opponents use, at depth 8,
 * with deterministic (most-central) tie-breaks.
 *
 * @param {number} [depth]
 * @returns {Agent}
 */
export function createEngineAgent(depth = 8) {
  return {
    id: `engine-d${depth}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const state = /** @type {State} */ (ctx.observation.data);
      const choice = chooseMove(state, { depth });
      return { text: String(choice.col + 1) };
    },
  };
}
