/**
 * The Gauntlet referee for live 2048 pages: given the previous board, the
 * direction the agent chose, and the next observed board, decides whether the
 * page's transition is exactly `slide(previous, direction)` plus one new 2 or
 * 4 in an empty cell — the rules in `gauntlet/games/2048/rules.js`.
 *
 * A live page is unseeded and outside the benchmark, so the referee does not
 * predict spawns; it only checks them after the fact. When no direction
 * explains the transition the verdict is `ok: false` and the session stops.
 * When the page moved under a *different* direction than the agent chose (the
 * overlay driver may try further directions after the engine's when the board
 * does not change), the verdict explains which direction was actually
 * applied and flags the divergence instead of failing.
 *
 * Pure, browser-safe: no `node:*`, no clocks, no randomness.
 *
 * @module
 */

import { DIRECTIONS, emptyCells, slide } from '../games/2048/rules.js';

/** @import { Board, Direction } from '../games/2048/rules.js' */

/**
 * A spawned tile: where it appeared and its value.
 * @typedef {object} Spawn
 * @property {number} r Row, 0 = top.
 * @property {number} c Column, 0 = left.
 * @property {number} value 2 or 4.
 */

/**
 * The referee's verdict for one transition.
 *
 * @typedef {object} Verdict
 * @property {boolean} ok False when no direction explains the transition.
 * @property {Direction | null} direction The direction the agent chose.
 * @property {Direction | null} applied The direction whose slide explains the
 *   transition. Equals `direction` on ordinary moves; differs when the driver
 *   fell through to another direction; null when nothing explains the board.
 * @property {Spawn | null} spawn The single new tile, when identified.
 * @property {boolean} diverged True when `applied` differs from `direction`.
 * @property {boolean} agentMove True when the agent supplied the applied move.
 * @property {string | null} reason Why the transition is not a legal move
 *   plus one spawn (null when ok), or a human-readable note on divergence.
 */

/**
 * Return whether a value is a valid 2048 board tile.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidTile(value) {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  if (value === 0) return true;
  const exponent = Math.log2(value);
  return value >= 2 && Number.isInteger(exponent);
}

/**
 * Return whether an array has only the own keys allowed by a board row.
 *
 * @param {unknown[]} row
 * @returns {boolean}
 */
function hasOnlyBoardKeys(row) {
  return Reflect.ownKeys(row).every(
    (key) => key === 'length' || (typeof key === 'string' && /^[0-3]$/.test(key)),
  );
}

/**
 * Validate the fixed board shape used by the 2048 rules.
 *
 * @param {*} board
 * @returns {boolean}
 */
export function isValidBoard(board) {
  if (!Array.isArray(board) || board.length !== 4 || !hasOnlyBoardKeys(board)) return false;
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 4 || !hasOnlyBoardKeys(row)) return false;
    for (let c = 0; c < row.length; c += 1) {
      if (!isValidTile(row[c])) return false;
    }
  }
  return true;
}

/**
 * Cells where two boards differ, as [r, c] pairs.
 *
 * @param {Board} a
 * @param {Board} b
 * @returns {[number, number][]}
 */
function differingCells(a, b) {
  /** @type {[number, number][]} */
  const cells = [];
  for (let r = 0; r < a.length && r < b.length; r++) {
    for (let c = 0; c < a[r].length && c < b[r].length; c++) {
      if (a[r][c] !== b[r][c]) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * Does `next` equal `slide(previous, dir)` plus exactly one new 2 or 4 in an
 * empty cell? Returns the spawn when it does.
 *
 * @param {Board} previous
 * @param {Direction} dir
 * @param {Board} next
 * @returns {Spawn | null}
 */
function explainWith(previous, dir, next) {
  const result = slide(previous, dir);
  if (!result.moved) return null;
  if (emptyCells(result.board).length === 0) return null; // a spawn was due
  const diffs = differingCells(result.board, next);
  if (diffs.length !== 1) return null;
  const [r, c] = diffs[0];
  if (result.board[r][c] !== 0) return null; // the new tile must land on a cell the slide left empty
  const value = next[r][c];
  if (value !== 2 && value !== 4) return null;
  return { r, c, value };
}

/**
 * Categorize an unexplained transition for the reason string.
 *
 * @param {Board} previous
 * @param {Direction} dir
 * @param {Board} next
 * @returns {string}
 */
function unexplainedReason(previous, dir, next) {
  const result = slide(previous, dir);
  if (!result.moved) {
    return `the agent's direction "${dir}" changes nothing and no other direction explains the page's board`;
  }
  if (emptyCells(result.board).length === 0) {
    return 'the slide left no empty cell, so no spawn was possible, yet the board changed';
  }
  const diffs = differingCells(result.board, next);
  if (diffs.length === 0) {
    return 'the page applied the slide but did not spawn exactly one tile (missing spawn)';
  }
  const extra = diffs.filter(([r, c]) => result.board[r][c] === 0 && (next[r][c] === 2 || next[r][c] === 4));
  if (extra.length >= 2 && extra.length === diffs.length) {
    return `the page spawned ${diffs.length} tiles after one slide (extra spawn)`;
  }
  const bad = diffs.filter(([r, c]) => result.board[r][c] !== 0 || (next[r][c] !== 2 && next[r][c] !== 4));
  if (bad.length >= 1 && bad.every(([r, c]) => result.board[r][c] !== 0)) {
    return 'the page changed cells the slide had already settled (merged or moved a settled tile)';
  }
  return `the page's board differs from slide(previous, "${dir}") plus one spawn in ${diffs.length} cells`;
}

/**
 * Referee one live transition.
 *
 * @param {Board} previous The board observed before the move.
 * @param {Direction | null} direction The direction the agent chose (null
 *   when the agent produced no usable action and the driver fell back).
 * @param {Board} next The board observed after the move.
 * @returns {Verdict}
 */
export function referee(previous, direction, next) {
  /** @type {(dir: Direction | null, applied: Direction | null, spawn: Spawn | null, diverged: boolean, agentMove: boolean, reason: string | null) => Verdict} */
  const verdict = (dir, applied, spawn, diverged, agentMove, reason) => ({
    ok: spawn !== null,
    direction: dir,
    applied,
    spawn,
    diverged,
    agentMove,
    reason,
  });

  if (!isValidBoard(previous) || !isValidBoard(next)) {
    return verdict(direction, null, null, false, direction !== null, 'the previous and next boards must each be a 4x4 grid of finite non-negative integers');
  }

  if (direction !== null && DIRECTIONS.includes(direction)) {
    const spawn = explainWith(previous, direction, next);
    if (spawn !== null) {
      return verdict(direction, direction, spawn, false, true, null);
    }
  }

  if (direction !== null && !DIRECTIONS.includes(direction)) {
    return verdict(direction, null, null, false, false, 'the agent chose an invalid direction');
  }

  // A missing action uses the driver's fixed fallback order. It remains a
  // valid observed transition, but it is not an agent move.
  if (direction === null) {
    for (const dir of /** @type {Direction[]} */ (['left', 'down', 'right', 'up'])) {
      const spawn = explainWith(previous, dir, next);
      if (spawn !== null) {
        return verdict(null, dir, spawn, false, false, `the agent produced no usable action; the driver fallback applied "${dir}"`);
      }
    }
    return verdict(null, null, null, false, false, 'the agent produced no usable action and the driver fallback did not change the board legally');
  }

  // The chosen direction did not explain the page. Look for one that does:
  // the driver tries further directions after the engine's when the board
  // does not change, and a live page may also receive an un-stuck move.
  for (const dir of DIRECTIONS) {
    if (dir === direction) continue;
    const spawn = explainWith(previous, dir, next);
    if (spawn !== null) {
      const reason = `the driver applied "${dir}" instead of the agent's "${direction}" (the chosen direction did not change the board)`;
      return verdict(direction, dir, spawn, true, false, reason);
    }
  }

  return verdict(direction, null, null, false, true, unexplainedReason(previous, direction, next));
}

export {};
