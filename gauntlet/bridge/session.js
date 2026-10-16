/**
 * A bridge session: one Gauntlet agent driving one live 2048 page through the
 * overlay's real adapter and driver, with Gauntlet's 2048 rules refereeing
 * every transition and a session log recording everything.
 *
 * The session drives the real `Driver` one move at a time (`driver.step()`),
 * exactly the code path the overlay's own loop uses: the driver reads the
 * page, asks the wrapped agent (via `toSolverEngine`) for a direction order,
 * sends key events through the real adapter, and may fall through to a
 * further direction when the chosen one does not change the board. After
 * every move the referee checks the transition against `slide` plus one spawn;
 * the first unexplained transition ends the session with that reason.
 *
 * @module
 */

import { referee } from './referee.js';
import { toSolverEngine } from './solver-engine.js';
import { createBridgeLog, endBridgeLog, recordStep } from './session-log.js';
import { game } from '../games/2048/index.js';

/** @import { Agent } from '../core/types.js' */
/** @import { Board, Direction } from '../games/2048/rules.js' */
/** @import { BridgeLog } from './session-log.js' */

/**
 * @typedef {object} BridgeSessionResult
 * @property {BridgeLog} log The session log (verify with verifyBridgeLog).
 * @property {string} endedWhy Why the session stopped: 'game-over', the
 *   referee reason, 'move-cap', or a driver failure reason.
 * @property {number} moves Successful, refereed moves.
 * @property {number} diverged How many moves the driver applied a different
 *   direction than the agent chose.
 */

/**
 * Play one bridge session.
 *
 * @param {object} setup
 * @param {*} setup.adapter A live overlay adapter (reads the board, sends moves).
 * @param {*} setup.driver A live overlay Driver with `setSolverEngine`, `step`.
 * @param {Agent} setup.agent The Gauntlet agent to drive the page.
 * @param {{ spec?: *, tier?: *, maxMoves?: number, startedAt?: string, finishedAt?: string }} [options]
 *   `spec`/`tier` pass through to the TurnContext; `maxMoves` caps the session
 *   (default 200).
 * @returns {Promise<BridgeSessionResult>}
 */
export async function playBridgeSession(setup, options = {}) {
  const maxMoves = options.maxMoves ?? 200;
  const { adapter, driver, agent } = setup;

  const engine = toSolverEngine(agent, {
    spec: options.spec,
    tier: options.tier,
    getScore: () => {
      const score = adapter.getScore();
      return typeof score === 'number' && Number.isFinite(score) ? score : 0;
    },
  });
  driver.setSolverEngine(engine);

  const initial = adapter.readBoard();
  if (!initial) {
    throw new Error('playBridgeSession: the adapter could not read an initial board');
  }
  const log = createBridgeLog({
    game: { id: game.spec.id, version: game.spec.version },
    agent: { id: agent.id, track: agent.track },
    initialBoard: /** @type {Board} */ (initial),
    startedAt: options.startedAt,
  });

  let turn = 0;
  let diverged = 0;
  /** @type {string | null} */
  let endedWhy = null;

  while (endedWhy === null && turn < maxMoves) {
    if (typeof adapter.isGameOver === 'function' && adapter.isGameOver()) {
      endedWhy = 'game-over';
      break;
    }

    const success = await driver.step();
    const after = adapter.readBoard();

    if (!success) {
      if (typeof adapter.isGameOver === 'function' && adapter.isGameOver()) {
        endedWhy = 'game-over';
      } else {
        endedWhy = engine.lastError ?? 'the driver could not change the board';
      }
      break;
    }

    const verdict = referee(/** @type {Board} */ (engine.lastBoard ?? initial), engine.lastChosen, /** @type {Board} */ (after));
    recordStep(log, {
      turn,
      boardBefore: /** @type {Board} */ (engine.lastBoard ?? initial),
      boardAfter: /** @type {Board} */ (after),
      verdict,
    });
    turn += 1;

    if (!verdict.ok) {
      endedWhy = `referee: ${verdict.reason}`;
      break;
    }
    if (verdict.diverged) diverged += 1;
  }

  if (endedWhy === null) endedWhy = 'move-cap';
  endBridgeLog(log, { reason: endedWhy, turn: log.steps.length, finishedAt: options.finishedAt });

  return { log, endedWhy, moves: log.steps.length, diverged };
}

/**
 * Driver direction number → Gauntlet direction string (values fixed by
 * `src/adapters/adapter.js`: UP 0, RIGHT 1, DOWN 2, LEFT 3).
 *
 * @type {Record<number, Direction>}
 */
const NUMBER_TO_DIR = { 0: 'up', 1: 'right', 2: 'down', 3: 'left' };

export {};
