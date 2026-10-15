/**
 * Connect Four rules on a bitboard: 7 columns x 6 rows, gravity, four in a
 * line in any direction wins, a full board is a draw.
 *
 * Bit layout: bit (col * 7 + row) of a 49-bit board, row 0 = bottom, so bit 6
 * of each 7-bit column block stays empty and acts as a carry guard. A 49-bit
 * board does not fit a 32-bit int, so a board is a pair of limbs: `a` holds
 * bits 0..27 and `b` holds bits 28..48 (21 used). All direction shifts stay
 * below the 28-bit limb width, so alignment checks are plain 32-bit ops.
 *
 * Pure JS, no `node:*`. No randomness and no clocks: every function here is
 * deterministic.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';

export const WIDTH = 7;
export const HEIGHT = 6;

/**
 * Canonical column names, 1-based left to right. The 1-based choice is stated
 * in the game's rulesText and observations.
 *
 * @type {string[]}
 */
export const COLUMNS = ['1', '2', '3', '4', '5', '6', '7'];

/** Limb split: bits 0..27 in `a`, bits 28..48 in `b`. */
const LIMB_BITS = 28;
const LIMB_MASK = 0x0fffffff;

/**
 * @param {number} col Zero-based column index.
 * @param {number} row Zero-based row index, 0 = bottom.
 * @returns {{ a: number, b: number }}
 */
export function bitFor(col, row) {
  const bit = col * 7 + row;
  return bit < LIMB_BITS
    ? { a: 1 << bit, b: 0 }
    : { a: 0, b: 1 << (bit - LIMB_BITS) };
}

/**
 * Right-shift a board pair by k (1..27) across the limb boundary.
 *
 * @param {{ a: number, b: number }} x
 * @param {number} k
 * @returns {{ a: number, b: number }}
 */
function shr(x, k) {
  return {
    a: ((x.a >>> k) | (x.b << (LIMB_BITS - k))) & LIMB_MASK,
    b: x.b >>> k,
  };
}

/**
 * @param {{ a: number, b: number }} x
 * @param {{ a: number, b: number }} y
 * @returns {{ a: number, b: number }}
 */
function and(x, y) {
  return { a: x.a & y.a, b: x.b & y.b };
}

/**
 * Four in a line along bit-difference d: cells x, x+d, x+2d, x+3d all set.
 * Direction shifts for this layout: 1 (vertical), 7 (horizontal), 6 and 8
 * (diagonals). The empty bit 6 of each column block prevents wraparound.
 *
 * @param {{ a: number, b: number }} bb
 * @param {number} d
 * @returns {boolean}
 */
function aligned(bb, d) {
  const m = and(bb, shr(bb, d));
  const m2 = and(m, shr(m, 2 * d));
  return m2.a !== 0 || m2.b !== 0;
}

/**
 * Does this bitboard contain four in a line in any direction?
 *
 * @param {{ a: number, b: number }} bb
 * @returns {boolean}
 */
export function hasAlignment(bb) {
  return aligned(bb, 1) || aligned(bb, 7) || aligned(bb, 6) || aligned(bb, 8);
}

/**
 * @typedef {object} Connect4State
 * @property {number[]} bb Two bitboards as [a, b] limb pairs flattened:
 *   bb[seat * 2] and bb[seat * 2 + 1]. Bit (col * 7 + row), row 0 = bottom.
 * @property {number[]} heights Discs per column (0..6).
 * @property {number} toMove Seat 0 (X) or 1 (O).
 * @property {'playing' | 'won' | 'draw'} status
 * @property {number | null} winner Winning seat when status is "won".
 * @property {number} discs Total discs placed (0..42).
 * @property {string[]} history Canonical actions so far, oldest first.
 * @property {number} openingPlies Random seeded plies played before the
 *   first agent turn (ladder tiers).
 * @property {number | null} forcedWinPlies On the forced-win tier: the exact
 *   proven number of plies until the agent's forced win completes.
 * @property {number} agentSeat The evaluated agent's seat, fixed at reset.
 */

/**
 * @param {number} agentSeat
 * @returns {Connect4State}
 */
export function emptyState(agentSeat) {
  return {
    bb: [0, 0, 0, 0],
    heights: [0, 0, 0, 0, 0, 0, 0],
    toMove: 0,
    status: 'playing',
    winner: null,
    discs: 0,
    history: [],
    openingPlies: 0,
    forcedWinPlies: null,
    agentSeat,
  };
}

/**
 * @param {Connect4State} state
 * @param {number} col Zero-based column index.
 * @returns {boolean}
 */
export function canPlay(state, col) {
  return state.heights[col] < HEIGHT;
}

/**
 * @param {Connect4State} state
 * @returns {number[]} Zero-based indices of non-full columns, ascending.
 */
export function legalCols(state) {
  const cols = [];
  for (let col = 0; col < WIDTH; col++) {
    if (state.heights[col] < HEIGHT) cols.push(col);
  }
  return cols;
}

/**
 * Apply a move and return a fresh state. Pure: the input is never mutated.
 *
 * @param {Connect4State} state
 * @param {number} seat
 * @param {number} col Zero-based column index.
 * @returns {Connect4State}
 * @throws {GauntletRuleError} when the seat is not to move or the column is
 *   full or out of range.
 */
export function applyMove(state, seat, col) {
  if (state.status !== 'playing') {
    throw new GauntletRuleError('the game is over');
  }
  if (seat !== state.toMove) {
    throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
  }
  if (!Number.isInteger(col) || col < 0 || col >= WIDTH) {
    throw new GauntletRuleError(`column ${JSON.stringify(col)} is out of range 1-${WIDTH}`);
  }
  if (state.heights[col] >= HEIGHT) {
    throw new GauntletRuleError(`column ${col + 1} is full`);
  }
  const row = state.heights[col];
  const bit = bitFor(col, row);
  const bb = state.bb.slice();
  bb[seat * 2] |= bit.a;
  bb[seat * 2 + 1] |= bit.b;
  const heights = state.heights.slice();
  heights[col] = row + 1;
  const won = hasAlignment({ a: bb[seat * 2], b: bb[seat * 2 + 1] });
  return {
    bb,
    heights,
    toMove: 1 - seat,
    status: won ? 'won' : state.discs + 1 === WIDTH * HEIGHT ? 'draw' : 'playing',
    winner: won ? seat : null,
    discs: state.discs + 1,
    history: state.history.concat(String(col + 1)),
    openingPlies: state.openingPlies,
    forcedWinPlies: state.forcedWinPlies,
    agentSeat: state.agentSeat,
  };
}

/**
 * Is the board completely full? (A draw.)
 *
 * @param {Connect4State} state
 * @returns {boolean}
 */
export function isFull(state) {
  return state.heights.every((h) => h >= HEIGHT);
}

/**
 * Fill the board from a per-column bottom-to-top mark plan, ignoring turn
 * alternation. Test helper: builds exact drawn/won positions.
 *
 * @param {Array<Array<'X' | 'O'>>} plan Seven arrays, one per column, each
 *   listing marks bottom to top.
 * @returns {Connect4State}
 */
export function stateFromPlan(plan) {
  let state = emptyState(0);
  for (let col = 0; col < WIDTH; col++) {
    const marks = plan[col] ?? [];
    for (let row = 0; row < marks.length; row++) {
      const seat = marks[row] === 'X' ? 0 : 1;
      state = { ...state, toMove: seat, status: 'playing', winner: null };
      state = applyMove(state, seat, col);
    }
  }
  return state;
}
