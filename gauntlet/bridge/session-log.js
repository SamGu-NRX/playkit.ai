/**
 * Session log for bridge play on live pages: format
 * `playkit-gauntlet-bridge-log/1`.
 *
 * A live page is unseeded — its spawns come from the page's own randomness,
 * not the episode RNG — so a bridge session cannot produce a benchmark
 * trajectory. The session log is a separate, honest record instead: every
 * observed board, the agent's action, the direction actually applied, and the
 * referee's verdict. `verifyBridgeLog` replays the recorded applied
 * directions through `slide` plus the recorded spawns and checks every
 * recorded board — an audit of what happened, never a scored run.
 *
 * @module
 */

import { referee } from './referee.js';

/** @import { Board, Direction } from '../games/2048/rules.js' */
/** @import { Spawn, Verdict } from './referee.js' */

/**
 * @typedef {object} BridgeLogStep
 * @property {number} turn Zero-based agent turn.
 * @property {Direction | null} chosen The agent's action (null when the agent
 *   produced no usable action and the driver fell back).
 * @property {Direction | null} applied The direction whose slide explains the
 *   transition (the driver may apply a different direction than chosen).
 * @property {boolean} diverged True when applied differs from chosen.
 * @property {Board} boardBefore The board observed before the move.
 * @property {Board} boardAfter The board observed after the move.
 * @property {Spawn | null} spawn The new tile, when the referee identified one.
 * @property {Verdict} verdict The referee's verdict for this transition.
 */

/**
 * @typedef {object} BridgeLog
 * @property {'playkit-gauntlet-bridge-log/1'} format
 * @property {{ id: string, version: string }} game
 * @property {{ id: string, track: string }} agent
 * @property {Board} initialBoard
 * @property {BridgeLogStep[]} steps
 * @property {{ reason: string, turn: number } | null} ended
 * @property {string} startedAt
 * @property {string | null} finishedAt
 */

/**
 * Open a session log.
 *
 * @param {{ game: { id: string, version: string }, agent: { id: string, track: string }, initialBoard: Board, startedAt?: string }} opening
 * @returns {BridgeLog}
 */
export function createBridgeLog(opening) {
  return {
    format: 'playkit-gauntlet-bridge-log/1',
    game: { id: opening.game.id, version: opening.game.version },
    agent: { id: opening.agent.id, track: opening.agent.track },
    initialBoard: opening.initialBoard.map((row) => row.slice()),
    steps: [],
    ended: null,
    startedAt: opening.startedAt ?? new Date().toISOString(),
    finishedAt: null,
  };
}

/**
 * Record one refereed transition. The boards are copied, so later play cannot
 * rewrite the record.
 *
 * @param {BridgeLog} log
 * @param {{ turn: number, boardBefore: Board, boardAfter: Board, verdict: Verdict }} step
 */
export function recordStep(log, step) {
  log.steps.push({
    turn: step.turn,
    chosen: step.verdict.direction,
    applied: step.verdict.applied,
    diverged: step.verdict.diverged,
    boardBefore: cloneBoard(step.boardBefore),
    boardAfter: cloneBoard(step.boardAfter),
    spawn: step.verdict.spawn,
    verdict: step.verdict,
  });
}

/**
 * Close the session log with the reason the session stopped.
 *
 * @param {BridgeLog} log
 * @param {{ reason: string, turn: number, finishedAt?: string }} ending
 */
export function endBridgeLog(log, ending) {
  log.ended = { reason: ending.reason, turn: ending.turn };
  log.finishedAt = ending.finishedAt ?? new Date().toISOString();
}

/**
 * @param {Board} board
 * @returns {Board}
 */
function cloneBoard(board) {
  return board.map((row) => row.slice());
}

/**
 * Verify a session log by replay: start from the recorded initial board and
 * re-derive every transition with `referee()` instead of trusting the saved
 * fields — the saved verdict, applied direction and spawn are attacker- and
 * bug-visible records, not evidence. Each step must chain onto the replayed
 * board (its recorded `boardBefore` must match), the referee must re-derive
 * the transition (which enforces the spawn rules: one new 2 or 4 in an empty
 * cell — `placeTile` alone would accept any value and overwrite occupied
 * cells), and the re-derived applied direction and spawn must match the saved
 * ones. A log of a clean session verifies; a forged or tampered log fails at
 * the first step that does not replay.
 *
 * @param {BridgeLog} log
 * @returns {{ ok: true, finalBoard: Board } | { ok: false, index: number, reason: string }}
 */
export function verifyBridgeLog(log) {
  if (log.format !== 'playkit-gauntlet-bridge-log/1') {
    return { ok: false, index: -1, reason: `unknown log format ${JSON.stringify(log.format)}` };
  }
  /** @type {Board} */
  let board = cloneBoard(log.initialBoard);
  for (let i = 0; i < log.steps.length; i++) {
    const step = log.steps[i];
    if (step.verdict === null || step.verdict === undefined || step.verdict.ok !== true) {
      return { ok: false, index: i, reason: 'the referee did not pass this transition' };
    }
    if (step.applied === null) {
      return { ok: false, index: i, reason: 'no applied direction recorded' };
    }
    if (JSON.stringify(step.boardBefore) !== JSON.stringify(board)) {
      return {
        ok: false,
        index: i,
        reason: 'the recorded boardBefore does not match the replayed board',
      };
    }
    const checked = referee(board, step.chosen, step.boardAfter);
    if (!checked.ok) {
      return {
        ok: false,
        index: i,
        reason: `replaying the recorded transition does not reproduce the recorded board: ${checked.reason}`,
      };
    }
    if (checked.applied !== step.applied) {
      return {
        ok: false,
        index: i,
        reason: `the recorded applied direction "${step.applied}" differs from the direction the referee re-derives ("${checked.applied}")`,
      };
    }
    if (JSON.stringify(checked.spawn) !== JSON.stringify(step.spawn)) {
      return {
        ok: false,
        index: i,
        reason: 'the recorded spawn is not the one the rules produce for this transition',
      };
    }
    board = cloneBoard(step.boardAfter);
  }
  return { ok: true, finalBoard: board };
}

export {};
