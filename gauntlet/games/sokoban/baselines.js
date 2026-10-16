/**
 * Sokoban baselines: the floor and the ceiling for the benchmark's baseline
 * track.
 *
 * - `greedyAgent` — pushes a box toward its nearest goal by Manhattan
 *   distance, walks toward the nearest useful push when no push is
 *   available, and breaks ties (and dead ends) with seeded choices. Weak on
 *   purpose: it has no lookahead, so it walks into deadlocks.
 * - `engineAgent` — follows the BFS solver's optimal plan, replanning from
 *   the current state whenever the state deviates from the plan (which is
 *   exactly what an undo or a fallback action causes). Perfect play: it
 *   scores par whenever it never deviates.
 *
 * Both are deterministic given the turn sequence (no clocks, no
 * `Math.random`; the seeded tie-breaks draw from the core RNG). No `node:*`.
 *
 * @module
 */

import { nextInt, streamFromSeed } from '../../core/rng.js';
import { deltasFor, solve, SolverBudgetError } from './solver.js';
import { applyAction } from './index.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */
/** @import { SokobanState } from './index.js' */

/**
 * @param {SokobanState} state
 * @returns {string}
 */
function stateKey(state) {
  return `${state.player}:${state.boxes.join(',')}`;
}

/**
 * Cheapest Manhattan distance from a box to any goal.
 *
 * @param {number} box
 * @param {readonly number[]} goals
 * @param {number} width
 * @returns {number}
 */
function boxDistanceToNearestGoal(box, goals, width) {
  const bx = box % width;
  const by = Math.floor(box / width);
  let best = Infinity;
  for (const g of goals) {
    const d = Math.abs((g % width) - bx) + Math.abs(Math.floor(g / width) - by);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The greedy baseline: no lookahead, no undo.
 *
 * @returns {Agent}
 */
export function greedyAgent() {
  return {
    id: 'sokoban-greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const state = /** @type {SokobanState} */ (ctx.observation.data);
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) return { text: 'undo' };

      // Score every legal move by the resulting box placement; pushing a box
      // toward its nearest goal wins, and when no push improves anything the
      // player walks toward the nearest box it could push.
      let bestScore = Infinity;
      /** @type {string[]} */
      let best = [];
      for (const action of legal) {
        const next = /** @type {SokobanState} */ (applyAction(state, action));
        let boxTerm = 0;
        for (const b of next.boxes) {
          boxTerm += boxDistanceToNearestGoal(b, state.goals, state.width);
        }
        let walkTerm = Infinity;
        for (const b of state.boxes) {
          const d = Math.abs((b % state.width) - (next.player % state.width)) +
            Math.abs(Math.floor(b / state.width) - Math.floor(next.player / state.width));
          if (d - 1 < walkTerm) walkTerm = d - 1;
        }
        if (!Number.isFinite(walkTerm)) walkTerm = 0;
        const score = 100 * boxTerm + walkTerm;
        if (score < bestScore) {
          bestScore = score;
          best = [action];
        } else if (score === bestScore) {
          best.push(action);
        }
      }
      // Seeded tie-break (and the only randomness here).
      const stream = streamFromSeed(`sokoban/greedy/${ctx.tier.id}/turn${ctx.turn}`);
      const choice = best[nextInt(stream.getState(), 0, best.length - 1).value];
      return { text: choice };
    },
  };
}

/**
 * The engine baseline: solver-perfect play, replanning from the current state
 * after any deviation (an undo in the history of the plan, or a fallback
 * action when the position was already unsolvable). When the solver proves
 * the current position unsolvable — only possible after a blunder the engine
 * itself would not make — it undoes one step, which is the replan.
 *
 * @param {{ nodeBudget?: number }} [options]
 * @returns {Agent}
 */
export function engineAgent(options = {}) {
  const nodeBudget = options.nodeBudget ?? 3000000;
  /** @type {string[] | null} */
  let plan = null;
  /** @type {string | null} */
  let expectedKey = null;
  return {
    id: 'sokoban-engine',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const state = /** @type {SokobanState} */ (ctx.observation.data);
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) return { text: 'undo' };

      const key = stateKey(state);
      if (!plan || plan.length === 0 || key !== expectedKey) {
        plan = null;
        try {
          const result = solve(
            { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
            { player: state.player, boxes: state.boxes },
            { nodeBudget, plan: true }
          );
          plan = result.plan;
        } catch (err) {
          if (!(err instanceof SolverBudgetError)) throw err;
          plan = null; // fall through to the undo-and-replan below
        }
      }

      /** @type {string} */
      let action;
      if (plan && plan.length > 0) {
        action = plan[0];
      } else if (state.history.length > 0) {
        action = 'undo'; // unsolvable or unsolved position: back out one step
      } else {
        action = legal[0]; // nothing better to do on the first move
      }

      const after = /** @type {SokobanState} */ (applyAction(state, action));
      expectedKey = stateKey(after);
      plan = plan && action !== 'undo' ? plan.slice(1) : null;
      return { text: action };
    },
  };
}
