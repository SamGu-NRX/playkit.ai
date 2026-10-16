/**
 * Go rules on a 9x9 board: captures, suicide illegal, positional superko,
 * pass, the game ends after two consecutive passes, and area scoring with
 * komi 7. Pure JS, no `node:*` imports (the browser overlay loads this
 * module), no randomness and no clocks: every function is deterministic.
 *
 * Coordinate convention (standard Go / GTP): columns A-J run left to right
 * and skip the letter I; ranks 1-9 run bottom to top; A1 is the bottom-left
 * corner. Vertices match GTP exactly, so a canonical action maps one-to-one
 * onto a GTP `play` command.
 *
 * Board layout: point (col, row) — col 0 = column A, row 0 = rank 1
 * (bottom) — is index `row * 9 + col`. Stone values: 0 empty, 1 Black
 * (seat 0), 2 White (seat 1).
 *
 * Superko: a move may not recreate any earlier whole-board position,
 * regardless of who is to move (positional superko). Every position reached,
 * including the initial empty board, is recorded in the state as its 81-char
 * board string; membership is checked by string comparison, which keeps the
 * state JSON-serializable and replays exact.
 *
 * Scoring: area (Chinese) scoring. A player's score is their stones on the
 * board plus empty regions bordered only by their stones; an empty region
 * bordered by both colours (or by neither) is neutral. White adds komi 7.
 * With integer komi, a jigo (draw) is possible and scores 0.5 per seat.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';

/** Board side: 9x9. */
export const SIZE = 9;

/** Komi paid to White under area scoring. */
export const KOMI = 7;

/** Column letters left to right; the letter I is skipped. */
export const COLUMN_LETTERS = /** @type {const} */ (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J']);

/**
 * A point's canonical name, e.g. "D5".
 *
 * @param {number} col Zero-based column index, 0 = column A.
 * @param {number} row Zero-based rank index, 0 = rank 1 (bottom).
 * @returns {string}
 */
export function nameOf(col, row) {
  return COLUMN_LETTERS[col] + String(row + 1);
}

/**
 * Parse a vertex name like "D5" or "d5". Returns null for anything that is
 * not a point on the board — including column I, which does not exist.
 *
 * @param {string} text
 * @returns {{ col: number, row: number } | null}
 */
export function parseName(text) {
  const m = /^([A-Ja-j])([1-9])$/.exec(text);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (letter === 'I') return null;
  const col = /** @type {readonly string[]} */ (COLUMN_LETTERS).indexOf(letter);
  if (col < 0) return null;
  return { col, row: Number(m[2]) - 1 };
}

/** Neighbour indices for every point, precomputed once. */
const NEIGHBORS = /** @type {number[][]} */ (
  Array.from({ length: SIZE * SIZE }, (_, index) => {
    const col = index % SIZE;
    const row = (index / SIZE) | 0;
    const out = [];
    if (col > 0) out.push(index - 1);
    if (col < SIZE - 1) out.push(index + 1);
    if (row > 0) out.push(index - SIZE);
    if (row < SIZE - 1) out.push(index + SIZE);
    return out;
  })
);

/**
 * The stone colour at `index`'s neighbours would flip: the opposite of
 * `colour` (1 <-> 2), 0 stays 0.
 *
 * @param {number} colour
 * @returns {number}
 */
function opponentOf(colour) {
  return colour === 1 ? 2 : 1;
}

/**
 * The connected same-colour group containing `index`, as indices, and its
 * liberty count. Flood fill over an 81-point board — cheap at this size.
 *
 * @param {number[]} board
 * @param {number} index
 * @returns {{ stones: number[], liberties: number }}
 */
export function groupAndLiberties(board, index) {
  const colour = board[index];
  const stones = [index];
  const seen = new Set(stones);
  const liberties = new Set();
  for (let head = 0; head < stones.length; head++) {
    for (const n of NEIGHBORS[stones[head]]) {
      if (board[n] === 0) {
        liberties.add(n);
      } else if (board[n] === colour && !seen.has(n)) {
        seen.add(n);
        stones.push(n);
      }
    }
  }
  return { stones, liberties: liberties.size };
}

/**
 * The board as an 81-character string ('0', '1', '2'), the position identity
 * used for positional superko.
 *
 * @param {number[]} board
 * @returns {string}
 */
export function boardString(board) {
  return board.join('');
}

/**
 * @typedef {object} GoState
 * @property {number[]} board 81 ints: 0 empty, 1 Black (seat 0), 2 White
 *   (seat 1). Index `row * 9 + col`, row 0 = rank 1 (bottom).
 * @property {number} toMove Seat 0 (Black) or 1 (White); Black plays first.
 * @property {'playing' | 'over'} status
 * @property {number} passes Consecutive passes so far, 0 or 1 (2 ends the
 *   game, so a state never carries 2).
 * @property {number[]} captures Stones captured BY each seat: [black, white].
 * @property {string[]} history Canonical actions oldest first: `play D5` or
 *   `pass`. Only accepted steps appear here.
 * @property {string[]} superko Board strings of every position reached so
 *   far, oldest first, including the initial empty board.
 * @property {string | null} koPoint The single-barred-recapture point from
 *   the last move (a simple-ko shape), for display; null after a pass.
 * @property {string | null} lastMove The last canonical action, or null.
 * @property {number} agentSeat The evaluated agent's seat, fixed at reset.
 */

/**
 * The empty board, Black to move.
 *
 * @param {number} agentSeat
 * @returns {GoState}
 */
export function emptyState(agentSeat) {
  const board = new Array(SIZE * SIZE).fill(0);
  return {
    board,
    toMove: 0,
    status: 'playing',
    passes: 0,
    captures: [0, 0],
    history: [],
    superko: [boardString(board)],
    koPoint: null,
    lastMove: null,
    agentSeat,
  };
}

/**
 * @typedef {object} MoveCheck
 * @property {boolean} ok
 * @property {string | null} error Rejection reason when not ok.
 * @property {number[] | null} board The board after the move (captures
 *   removed), when ok.
 * @property {number} capturedStones Stones removed from the opponent.
 * @property {number[]} capturedIndices Their indices, ascending.
 */

/**
 * Check a stone placement without producing a full state: occupied point,
 * suicide, and positional superko are rejected with a precise reason. Pure.
 *
 * @param {GoState} state
 * @param {number} seat
 * @param {number} col
 * @param {number} row
 * @returns {MoveCheck}
 */
export function checkMove(state, seat, col, row) {
  const index = row * SIZE + col;
  const colour = seat + 1;
  if (state.board[index] !== 0) {
    return { ok: false, error: `${nameOf(col, row)} is already occupied`, board: null, capturedStones: 0, capturedIndices: [] };
  }
  const board = state.board.slice();
  board[index] = colour;
  const enemy = opponentOf(colour);
  /** @type {number[]} */
  const capturedIndices = [];
  const removed = new Set();
  for (const n of NEIGHBORS[index]) {
    if (board[n] === enemy && !removed.has(n)) {
      const group = groupAndLiberties(board, n);
      if (group.liberties === 0) {
        for (const s of group.stones) {
          removed.add(s);
          capturedIndices.push(s);
        }
      }
    }
  }
  for (const s of capturedIndices) board[s] = 0;
  capturedIndices.sort((a, b) => a - b);
  const own = groupAndLiberties(board, index);
  if (own.liberties === 0) {
    return {
      ok: false,
      error: `${nameOf(col, row)} would have no liberties and captures nothing (suicide is illegal)`,
      board: null,
      capturedStones: 0,
      capturedIndices: [],
    };
  }
  const position = boardString(board);
  if (state.superko.includes(position)) {
    return {
      ok: false,
      error: `${nameOf(col, row)} would recreate an earlier position (positional superko)`,
      board: null,
      capturedStones: 0,
      capturedIndices: [],
    };
  }
  return { ok: true, error: null, board, capturedStones: capturedIndices.length, capturedIndices };
}

/**
 * The simple-ko point left by a move, for display: the move captured exactly
 * one stone, the played stone is alone in its group with exactly one
 * liberty, and that liberty is the captured point — so the opponent's
 * immediate recapture there is barred by superko.
 *
 * @param {number[]} boardBefore
 * @param {number[]} boardAfter
 * @param {number} index The played point.
 * @param {number[]} capturedIndices
 * @returns {string | null}
 */
function koPointOf(boardBefore, boardAfter, index, capturedIndices) {
  if (capturedIndices.length !== 1) return null;
  const captured = capturedIndices[0];
  if (!NEIGHBORS[captured].includes(index)) return null;
  const group = groupAndLiberties(boardAfter, index);
  if (group.stones.length !== 1 || group.liberties !== 1) return null;
  const [liberty] = /** the single liberty */ libertiesOf(boardAfter, index);
  return liberty === captured ? nameOf(captured % SIZE, (captured / SIZE) | 0) : null;
}

/**
 * The single liberty point of a one-liberty group, helper for `koPointOf`.
 *
 * @param {number[]} board
 * @param {number} index
 * @returns {number[]}
 */
function libertiesOf(board, index) {
  const colour = board[index];
  const stones = [index];
  const seen = new Set(stones);
  const liberties = new Set();
  for (let head = 0; head < stones.length; head++) {
    for (const n of NEIGHBORS[stones[head]]) {
      if (board[n] === 0) liberties.add(n);
      else if (board[n] === colour && !seen.has(n)) {
        seen.add(n);
        stones.push(n);
      }
    }
  }
  return [...liberties];
}

/**
 * Apply a stone placement and return a fresh state. Pure; throws
 * GauntletRuleError for anything `checkMove` rejects.
 *
 * @param {GoState} state
 * @param {number} seat
 * @param {number} col
 * @param {number} row
 * @returns {GoState}
 * @throws {GauntletRuleError}
 */
export function playGo(state, seat, col, row) {
  if (state.status !== 'playing') throw new GauntletRuleError('the game is over');
  if (seat !== state.toMove) {
    throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
  }
  const check = checkMove(state, seat, col, row);
  if (!check.ok) throw new GauntletRuleError(/** @type {string} */ (check.error));
  const board = /** @type {number[]} */ (check.board);
  const captures = state.captures.slice();
  captures[seat] += check.capturedStones;
  const next = {
    board,
    toMove: 1 - seat,
    status: /** @type {'playing' | 'over'} */ ('playing'),
    passes: 0,
    captures,
    history: state.history.concat(`play ${nameOf(col, row)}`),
    superko: state.superko.concat(boardString(board)),
    koPoint: koPointOf(state.board, board, row * SIZE + col, check.capturedIndices),
    lastMove: `play ${nameOf(col, row)}`,
    agentSeat: state.agentSeat,
  };
  return next;
}

/**
 * Apply a pass. Pass is always legal while the game is running; the game
 * ends after two consecutive passes.
 *
 * @param {GoState} state
 * @param {number} seat
 * @returns {GoState}
 * @throws {GauntletRuleError}
 */
export function passGo(state, seat) {
  if (state.status !== 'playing') throw new GauntletRuleError('the game is over');
  if (seat !== state.toMove) {
    throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
  }
  const passes = state.passes + 1;
  return {
    board: state.board.slice(),
    toMove: 1 - seat,
    status: passes >= 2 ? 'over' : 'playing',
    passes,
    captures: state.captures.slice(),
    history: state.history.concat('pass'),
    superko: state.superko.slice(),
    koPoint: null,
    lastMove: 'pass',
    agentSeat: state.agentSeat,
  };
}

/**
 * Area score of a position: each player's stones plus empty regions bordered
 * only by their stones, White adding komi. Shared or colour-less empty
 * regions are neutral. Returns raw totals (komi included in White's).
 *
 * @param {number[]} board
 * @returns {{ black: number, white: number, blackTerritory: number, whiteTerritory: number, dame: number }}
 */
export function areaScore(board) {
  let blackStones = 0;
  let whiteStones = 0;
  for (const v of board) {
    if (v === 1) blackStones++;
    else if (v === 2) whiteStones++;
  }
  const seen = new Array(SIZE * SIZE).fill(false);
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let dame = 0;
  for (let start = 0; start < board.length; start++) {
    if (board[start] !== 0 || seen[start]) continue;
    /** @type {number[]} */
    const region = [start];
    seen[start] = true;
    let touchesBlack = false;
    let touchesWhite = false;
    for (let head = 0; head < region.length; head++) {
      for (const n of NEIGHBORS[region[head]]) {
        if (board[n] === 0) {
          if (!seen[n]) {
            seen[n] = true;
            region.push(n);
          }
        } else if (board[n] === 1) touchesBlack = true;
        else touchesWhite = true;
      }
    }
    if (touchesBlack && !touchesWhite) blackTerritory += region.length;
    else if (touchesWhite && !touchesBlack) whiteTerritory += region.length;
    else dame += region.length;
  }
  return {
    black: blackStones + blackTerritory,
    white: whiteStones + whiteTerritory + KOMI,
    blackTerritory,
    whiteTerritory,
    dame,
  };
}

/**
 * The outcome of a finished position, scored by area with komi 7.
 *
 * @param {GoState} state
 * @returns {{ normalized: number[], raw: string[], reason: string }} Seat-
 *   indexed normalized scores (1 / 0.5 / 0); raw is [blackTotal, whiteTotal]
 *   as strings for exact JSON.
 */
export function outcomeOf(state) {
  const score = areaScore(state.board);
  const { black, white } = score;
  if (black === white) {
    return {
      normalized: [0.5, 0.5],
      raw: [String(black), String(white)],
      reason: `jigo (draw): area ${black} each, komi 7 included in White's count`,
    };
  }
  const winner = black > white ? 0 : 1;
  return {
    normalized: winner === 0 ? [1, 0] : [0, 1],
    raw: [String(black), String(white)],
    reason:
      winner === 0
        ? `seat 0 (Black) wins by ${black - white} on area: Black ${black}, White ${white} (komi 7 included)`
        : `seat 1 (White) wins by ${white - black} on area: White ${white}, Black ${black} (komi 7 included)`,
  };
}
