/**
 * The sliding-puzzle reference agent: plays the proven-optimal line. On each
 * turn it re-solves the board in `observation.data` (the state this game
 * publishes, including the current board) and returns the first move of an
 * optimal solution, so it stays correct even after it is seated into a
 * mid-game board. IDA* with an admissible Manhattan + linear-conflict
 * heuristic is fast for these tier sizes (worst observed solve well under a
 * second); the agent re-solves whenever the board changes and keeps the last
 * solution only to answer a repeated call on the same board.
 *
 * No `node:*`.
 *
 * @module
 */

import { solve } from '../games/sliding/solver.js';

/** @import { Agent } from '../core/types.js' */

/**
 * @typedef {object} SlidingSolverAgentOptions
 * @property {string} [id] Default "sliding-solver".
 * @property {'baseline' | 'community'} [track] Default "baseline".
 * @property {string} [episodeSeed] Accepted for harness compatibility; the
 * agent is deterministic and ignores it.
 */

/**
 * Build the reference solver agent.
 * @param {SlidingSolverAgentOptions} [options]
 * @returns {Agent}
 */
export function createSlidingSolverAgent({ id = 'sliding-solver', track = 'baseline' } = {}) {
  /** @type {string[] | null} */
  let plan = null;
  /** @type {string | null} */
  let planKey = null;
  return {
    id,
    track,
    async act(ctx) {
      const data = /** @type {{ board?: number[][], size?: number } | undefined} */ (
        ctx.observation && ctx.observation.data
      );
      const board = data && data.board;
      const size = data && data.size;
      if (!Array.isArray(board) || typeof size !== 'number') {
        throw new Error(
          `solver agent "${id}" needs observation.data.board and observation.data.size; sliding publishes both`
        );
      }
      const key = JSON.stringify(board);
      if (plan && planKey === key && plan.length > 0) {
        return { text: plan[0] };
      }
      if (plan && planKey === key && plan.length === 0) {
        throw new Error(`solver agent "${id}" was asked to act on a solved board`);
      }
      const result = solve(board);
      if (result.status !== 'solved') {
        throw new Error(`solver agent "${id}": solve() returned ${result.status}`);
      }
      plan = result.moves.slice();
      planKey = key;
      return { text: plan[0] };
    },
  };
}
