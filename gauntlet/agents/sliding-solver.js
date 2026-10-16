/**
 * The sliding-puzzle reference agent: plays the proven-optimal line. On its
 * first turn it solves the board in `observation.data` (the state this game
 * publishes, including the current board) and then FOLLOWS that plan move by
 * move, advancing the expected board with the game's own move semantics. It
 * re-solves only when the actual board differs from the expected one — when
 * seated into a mid-game board, after a detour, or on any other surprise — so
 * one episode costs one solve (re-solving every turn costs a full IDA* search
 * per move, and on the long 15-puzzle tiers those searches dominate the
 * calibration wall time).
 *
 * The underlying IDA* is admissible-heuristic optimal, so the plan is a
 * proven-optimal line and following it scores the tier's efficiency 1.0.
 *
 * No `node:*`.
 *
 * @module
 */

import { applyTileMove, solve } from '../games/sliding/solver.js';

/** @import { Agent } from '../core/types.js' */

/**
 * @typedef {object} SlidingSolverAgentOptions
 * @property {string} [id] Default "sliding-solver".
 * @property {'baseline' | 'community'} [track] Default "baseline".
 * @property {string} [episodeSeed] Accepted for harness compatibility; the
 * agent is deterministic and ignores it.
 */

/**
 * @param {number[][]} board
 * @returns {string}
 */
function boardKey(board) {
  return JSON.stringify(board);
}

/**
 * Build the reference solver agent.
 * @param {SlidingSolverAgentOptions} [options]
 * @returns {Agent}
 */
export function createSlidingSolverAgent({ id = 'sliding-solver', track = 'baseline' } = {}) {
  /** Remaining moves of the current plan. @type {string[] | null} */
  let plan = null;
  /** The board the remaining plan starts from. @type {number[][] | null} */
  let planBoard = null;
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
      if (plan && planBoard && boardKey(planBoard) === boardKey(board)) {
        if (plan.length === 0) {
          throw new Error(`solver agent "${id}" was asked to act on a solved board`);
        }
      } else {
        // The board is not where our plan expected it (mid-game seating, a
        // detour, a different seat count of turns): re-solve from here.
        const result = solve(board);
        if (result.status !== 'solved') {
          throw new Error(`solver agent "${id}": solve() returned ${result.status}`);
        }
        plan = result.moves.map((move) => /** @type {string} */ (move));
        planBoard = board.map((row) => row.slice());
      }
      const move = /** @type {string} */ (plan[0]);
      // Advance the tracked board along the move we are about to play, so the
      // next turn's key check follows the plan without another solve.
      const next = applyTileMove(/** @type {number[][]} */ (planBoard), /** @type {import('../games/sliding/solver.js').Direction} */ (move));
      if (!next) {
        throw new Error(`solver agent "${id}": planned move ${move} is not legal on the tracked board`);
      }
      plan = plan.slice(1);
      planBoard = next;
      return { text: move };
    },
  };
}
