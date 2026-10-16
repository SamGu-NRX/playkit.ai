/**
 * Bridge from Gauntlet agents to the overlay's solver-engine interface.
 *
 * The overlay driver asks its engine for a direction order with
 * `getMoveOrder(board)` (see `src/driver/driver.js`); draft PR #9's
 * `getPreferredSolverEngine` hook installs exactly such objects per adapter.
 * `toSolverEngine(agent)` wraps any Gauntlet `Agent` (`act(TurnContext)` in
 * `core/types.js`) as that interface: each call builds a TurnContext from the
 * board the driver observed, calls the agent, parses its reply with the 2048
 * game's own `parseAction`, and maps the direction to the driver's numeric
 * constants (UP 0, RIGHT 1, DOWN 2, LEFT 3). The agent's choice is returned
 * first; the remaining directions follow so the driver can try further
 * directions when the chosen one does not change the board — the referee
 * identifies which one actually applied.
 *
 * Browser-safe (no `node:*`, no clocks, no randomness): this module also
 * loads in the overlay bundle.
 *
 * @module
 */

import { game } from '../games/2048/index.js';
import { DIRECTIONS, observationForBoard, slide } from '../games/2048/rules.js';
import { rngFromSeed } from '../core/rng.js';
import { extractAction } from '../core/runner.js';

/** @import { Agent, AgentReply, GameSpec, TierSpec, TurnContext } from '../core/types.js' */
/** @import { Board, Direction } from '../games/2048/rules.js' */

/**
 * The driver's numeric direction constants. Mirrored here so the bridge never
 * mutates or depends on the identity of the overlay module object; the
 * values are fixed by `src/adapters/adapter.js`.
 *
 * @typedef {object} NumericDirections
 * @property {0} UP
 * @property {1} RIGHT
 * @property {2} DOWN
 * @property {3} LEFT
 */

/** @type {NumericDirections} */
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };

/**
 * Gauntlet direction string → driver number.
 *
 * @type {Record<Direction, number>}
 */
const TO_NUMBER = { up: DIR.UP, right: DIR.RIGHT, down: DIR.DOWN, left: DIR.LEFT };

/**
 * @param {Board} board
 * @returns {boolean}
 */
function isValidBoard(board) {
  return (
    Array.isArray(board) &&
    board.length === 4 &&
    board.every((row) => Array.isArray(row) && row.length === 4 && row.every((v) => typeof v === 'number'))
  );
}

/**
 * Wrap a Gauntlet agent as an overlay solver engine.
 *
 * @param {Agent} agent Any Gauntlet agent (a baseline today, a model agent later).
 * @param {{ spec?: GameSpec, tier?: TierSpec, getScore?: () => number }} [options]
 *   `spec` and `tier` fill the TurnContext; `getScore` supplies the page score
 *   shown in the observation when the caller has one (live pages are
 *   unseeded, so the score is informational only).
 * @returns {{
 *   initialize: () => Promise<void>,
 *   ensureReady: () => Promise<void>,
 *   getMoveOrder: (board: number[][]) => Promise<number[]>,
 *   setStrategy: () => Promise<void>,
 *   getStatus: () => { type: string, ready: boolean, agentId: string, turns: number, lastChosen: Direction | null, lastError: string | null },
 *   lastChosen: Direction | null,
 *   lastBoard: Board | null,
 *   lastError: string | null,
 * }} An object with the methods the driver calls, plus the last turn's
 *   records for the referee and session log.
 */
export function toSolverEngine(agent, options = {}) {
  const spec = options.spec ?? game.spec;
  const tier = options.tier ?? game.spec.tiers[0];
  const getScore = options.getScore ?? (() => 0);

  let turns = 0;
  /** @type {Direction | null} */
  let lastChosen = null;
  /** @type {Board | null} */
  let lastBoard = null;
  /** @type {string | null} */
  let lastError = null;

  return {
    async initialize() {
      // Nothing to precompute: the agent is ready by construction.
    },

    async ensureReady() {},

    /**
     * The driver's entry point: one agent turn per call.
     *
     * @param {number[][]} board The board the driver observed.
     * @returns {Promise<number[]>} Directions to try, best first.
     */
    async getMoveOrder(board) {
      lastChosen = null;
      lastError = null;
      if (!isValidBoard(board)) {
        lastError = 'the driver passed an invalid board';
        return [];
      }
      lastBoard = board.map((row) => row.slice());
      const score = getScore();
      const legal = DIRECTIONS.filter((dir) => slide(board, dir).moved).sort();

      /** @type {TurnContext} */
      const ctx = {
        spec,
        tier,
        seat: 0,
        turn: turns,
        observation: observationForBoard(/** @type {Board} */ (lastBoard), score),
        legalActions: legal,
        feedback: null,
      };
      turns += 1;

      /** @type {AgentReply} */
      const reply = await agent.act(ctx);
      // Read the action exactly the way runEpisode() does (see
      // core/runner.js): extractAction() takes the last non-empty line and
      // strips wrapping quotes/backticks and a leading "action:" prefix, so a
      // supported reply like "Action: right" parses here instead of being
      // rejected and pushing the driver onto its fallback order.
      const attempted = extractAction(typeof reply.text === 'string' ? reply.text : '');
      if (attempted === null) {
        lastError = 'no action found in the agent reply';
        return [];
      }
      const parsed = game.parseAction(
        { board: /** @type {Board} */ (lastBoard), score, rng: rngFromSeed('bridge-live'), status: 'playing', target: 2048 },
        0,
        attempted,
      );
      if (!parsed.ok) {
        lastError = `the agent's reply was rejected: ${parsed.error}`;
        return [];
      }
      const chosen = /** @type {Direction} */ (parsed.action);
      lastChosen = chosen;
      const chosenNumber = TO_NUMBER[chosen];
      const rest = [DIR.UP, DIR.RIGHT, DIR.DOWN, DIR.LEFT].filter((n) => n !== chosenNumber);
      return [chosenNumber, ...rest];
    },

    async setStrategy() {
      // No tunables: the agent decides.
    },

    getStatus() {
      return {
        type: 'gauntlet-agent',
        ready: true,
        agentId: agent.id,
        turns,
        lastChosen,
        lastError,
      };
    },

    get lastChosen() {
      return lastChosen;
    },

    get lastBoard() {
      return lastBoard;
    },

    get lastError() {
      return lastError;
    },
  };
}

export {};
