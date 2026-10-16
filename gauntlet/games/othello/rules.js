/**
 * Othello (Reversi) rules on a two-limb bitboard: an 8x8 board, Black moves
 * first, a placement flips every straight line of opponent discs bracketed
 * between the new disc and one of the mover's existing discs, a player with
 * no legal placement must play `pass`, and the game ends when the board is
 * full or neither side can place.
 *
 * Coordinate convention (standard Othello notation): files a-h run left to
 * right, ranks 1-8 run top to bottom, so a1 is the top-left corner. The
 * standard opening has White on d4 and e5 and Black on d5 and e4, and the
 * four legal opening moves are c4, d3, e6 and f5.
 *
 * Bit layout: square (row, col) — row 0 = rank 1 (top), col 0 = file a — is
 * bit row * 8 + col. Limb `a` holds bits 0..31 (ranks 1-4) and limb `b` bits
 * 32..63 (ranks 5-8), each a plain 32-bit int. Direction shifts move bits
 * across the limb boundary arithmetically, and file masks strip everything
 * that would wrap between files a and h on horizontal and diagonal shifts.
 *
 * The hot path (`genMoves`, `flipsFor`, `perft`) works on scalars through
 * module-level temporaries instead of allocating: JS is single-threaded and
 * none of these functions re-enter, so that is safe. Callers must copy the
 * temporaries out before recursing.
 *
 * Pure JS, no `node:*`. No randomness and no clocks: every function here is
 * deterministic.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';

export const WIDTH = 8;
export const HEIGHT = 8;

/** Squares not in file a (the low bit of each 8-bit row byte). */
const NOT_FILE_A = 0xfefefefe;
/** Squares not in file h (the high bit of each 8-bit row byte). */
const NOT_FILE_H = 0x7f7f7f7f;

/**
 * A square's bits as a limb pair.
 *
 * @param {number} col Zero-based file index, 0 = file a.
 * @param {number} row Zero-based rank index, 0 = rank 1 (top).
 * @returns {{ a: number, b: number }}
 */
export function bitFor(col, row) {
  const bit = row * 8 + col;
  return bit < 32 ? { a: 1 << bit, b: 0 } : { a: 0, b: 1 << (bit - 32) };
}

/**
 * The square's canonical name, e.g. "d3".
 *
 * @param {number} col Zero-based file index.
 * @param {number} row Zero-based rank index.
 * @returns {string}
 */
export function nameOf(col, row) {
  return String.fromCharCode(97 + col) + String(row + 1);
}

/**
 * Parse a coordinate name like "d3" or "D3". Returns null for anything that
 * is not a square on the board.
 *
 * @param {string} text
 * @returns {{ col: number, row: number } | null}
 */
export function parseName(text) {
  const m = /^([a-hA-H])([1-8])$/.exec(text);
  if (!m) return null;
  return { col: m[1].toLowerCase().charCodeAt(0) - 97, row: Number(m[2]) - 1 };
}

/** Direction shifts write their result into `_sa`/`_sb`. */
let _sa = 0;
let _sb = 0;

/** @param {number} a @param {number} b */
function shiftE(a, b) {
  _sa = ((a << 1) & NOT_FILE_A) >>> 0;
  _sb = (((b << 1) | (a >>> 31)) & NOT_FILE_A) >>> 0;
}

/** @param {number} a @param {number} b */
function shiftW(a, b) {
  _sa = (((a >>> 1) | (b << 31)) & NOT_FILE_H) >>> 0;
  _sb = (b >>> 1) & NOT_FILE_H;
}

/** @param {number} a @param {number} b */
function shiftN(a, b) {
  _sa = ((a >>> 8) | (b << 24)) >>> 0;
  _sb = b >>> 8;
}

/** @param {number} a @param {number} b */
function shiftS(a, b) {
  _sa = (a << 8) >>> 0;
  _sb = ((b << 8) | (a >>> 24)) >>> 0;
}

/** North-east: row-1, col+1 (bit -7). A source on file h would wrap to file a. */
/** @param {number} a @param {number} b */
function shiftNE(a, b) {
  _sa = (((a >>> 7) | (b << 25)) & NOT_FILE_A) >>> 0;
  _sb = ((b >>> 7) & NOT_FILE_A) >>> 0;
}

/** North-west: row-1, col-1 (bit -9). A source on file a would wrap to file h. */
/** @param {number} a @param {number} b */
function shiftNW(a, b) {
  _sa = (((a >>> 9) | (b << 23)) & NOT_FILE_H) >>> 0;
  _sb = ((b >>> 9) & NOT_FILE_H) >>> 0;
}

/** South-east: row+1, col-1 (bit +7). A source on file a would wrap to file h. */
/** @param {number} a @param {number} b */
function shiftSE(a, b) {
  _sa = ((a << 7) & NOT_FILE_H) >>> 0;
  _sb = (((b << 7) | (a >>> 25)) & NOT_FILE_H) >>> 0;
}

/** South-west: row+1, col+1 (bit +9). A source on file h would wrap to file a. */
/** @param {number} a @param {number} b */
function shiftSW(a, b) {
  _sa = ((a << 9) & NOT_FILE_A) >>> 0;
  _sb = (((b << 9) | (a >>> 23)) & NOT_FILE_A) >>> 0;
}

/** @type {((a: number, b: number) => void)[]} */
const SHIFTS = [shiftE, shiftW, shiftN, shiftS, shiftNE, shiftNW, shiftSE, shiftSW];

/** `genMoves` writes the placement bitboard into `_ra`/`_rb`. */
let _ra = 0;
let _rb = 0;

/**
 * All empty squares where a placement would bracket at least one opponent
 * disc, as a limb pair. Dilation per direction: start from the opponent
 * discs adjacent to a mover disc, extend the run along the direction while
 * it stays on opponent discs (a captured line is at most six long), and the
 * empty squares one step beyond a run are the moves.
 *
 * @param {number} mA Mover's low limb.
 * @param {number} mB Mover's high limb.
 * @param {number} oA Opponent's low limb.
 * @param {number} oB Opponent's high limb.
 * @returns {void} Results in `_ra`/`_rb`; copy before recursing.
 */
function genMoves(mA, mB, oA, oB) {
  const eA = (~(mA | oA)) >>> 0;
  const eB = (~(mB | oB)) >>> 0;
  let rA = 0;
  let rB = 0;
  for (let d = 0; d < 8; d++) {
    const shift = SHIFTS[d];
    shift(mA, mB);
    let cumA = _sa & oA;
    let cumB = _sb & oB;
    if ((cumA | cumB) === 0) continue;
    for (let k = 0; k < 5; k++) {
      shift(cumA, cumB);
      const nA = _sa & oA;
      const nB = _sb & oB;
      if ((nA | nB) === 0) break;
      cumA |= nA;
      cumB |= nB;
    }
    shift(cumA, cumB);
    rA |= _sa & eA;
    rB |= _sb & eB;
  }
  _ra = rA;
  _rb = rB;
}

/** `flipsFor` writes the flipped-disc bitboard into `_fa`/`_fb`. */
let _fa = 0;
let _fb = 0;

/**
 * The discs flipped by a placement at (col, row) for the mover: per
 * direction, the contiguous opponent run from the square outward, kept only
 * when a mover disc closes the far end.
 *
 * @param {number} mA Mover's low limb.
 * @param {number} mB Mover's high limb.
 * @param {number} oA Opponent's low limb.
 * @param {number} oB Opponent's high limb.
 * @param {number} col Zero-based file index.
 * @param {number} row Zero-based rank index.
 * @returns {void} Results in `_fa`/`_fb`; copy before recursing.
 */
function flipsFor(mA, mB, oA, oB, col, row) {
  const bit = row * 8 + col;
  const pA = bit < 32 ? 1 << bit : 0;
  const pB = bit < 32 ? 0 : 1 << (bit - 32);
  let fA = 0;
  let fB = 0;
  for (let d = 0; d < 8; d++) {
    const shift = SHIFTS[d];
    shift(pA, pB);
    let cumA = _sa & oA;
    let cumB = _sb & oB;
    if ((cumA | cumB) === 0) continue;
    for (let k = 0; k < 5; k++) {
      shift(cumA, cumB);
      const nA = _sa & oA;
      const nB = _sb & oB;
      if ((nA | nB) === 0) break;
      cumA |= nA;
      cumB |= nB;
    }
    shift(cumA, cumB);
    if ((_sa & mA) !== 0 || (_sb & mB) !== 0) {
      fA |= cumA;
      fB |= cumB;
    }
  }
  _fa = fA;
  _fb = fB;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function popcount2(a, b) {
  let n = 0;
  while (a !== 0) {
    a &= a - 1;
    n++;
  }
  while (b !== 0) {
    b &= b - 1;
    n++;
  }
  return n;
}

/**
 * The set bits of a limb pair as squares, ascending by bit index.
 *
 * @param {number} a Low limb.
 * @param {number} b High limb.
 * @returns {{ col: number, row: number }[]}
 */
export function bitsOf(a, b) {
  const out = [];
  let x = a >>> 0;
  while (x !== 0) {
    const low = x & -x;
    const bit = 31 - Math.clz32(low);
    out.push({ col: bit % 8, row: (bit / 8) | 0 });
    x &= x - 1;
  }
  x = b >>> 0;
  while (x !== 0) {
    const low = x & -x;
    const bit = 31 - Math.clz32(low);
    out.push({ col: bit % 8, row: ((bit + 32) / 8) | 0 });
    x &= x - 1;
  }
  return out;
}

/**
 * Value-returning wrappers over the scalar hot path, for the engine and the
 * perft driver. Each allocates one small object per call.
 *
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @returns {{ a: number, b: number }}
 */
export function movesBB(mA, mB, oA, oB) {
  genMoves(mA, mB, oA, oB);
  return { a: _ra, b: _rb };
}

/**
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @param {number} col
 * @param {number} row
 * @returns {{ a: number, b: number }}
 */
export function flipsBB(mA, mB, oA, oB, col, row) {
  flipsFor(mA, mB, oA, oB, col, row);
  return { a: _fa, b: _fb };
}

/**
 * @typedef {object} OthelloState
 * @property {number[]} bb Two bitboards as [a, b] limb pairs flattened:
 *   bb[0]/bb[1] are Black's low/high limbs (seat 0), bb[2]/bb[3] White's
 *   (seat 1). Bit (row * 8 + col); row 0 = rank 1 (top).
 * @property {number} toMove Seat 0 (Black) or 1 (White).
 * @property {'playing' | 'over'} status
 * @property {number} discs Discs placed, 4..64.
 * @property {string[]} history Canonical actions so far (coordinates and
 *   passes), oldest first.
 * @property {number} openingPlies Seeded random plies played before the
 *   first agent turn.
 * @property {number} agentSeat The evaluated agent's seat, fixed at reset.
 */

/**
 * The standard opening position: White on d4 and e5, Black on d5 and e4,
 * Black to move.
 *
 * @param {number} agentSeat
 * @returns {OthelloState}
 */
export function emptyState(agentSeat) {
  const white = [
    bitFor(3, 3), // d4
    bitFor(4, 4), // e5
  ];
  const black = [
    bitFor(3, 4), // d5
    bitFor(4, 3), // e4
  ];
  return {
    bb: [
      black[0].a | black[1].a,
      black[0].b | black[1].b,
      white[0].a | white[1].a,
      white[0].b | white[1].b,
    ],
    toMove: 0,
    status: 'playing',
    discs: 4,
    history: [],
    openingPlies: 0,
    agentSeat,
  };
}

/**
 * Disc counts as [black, white].
 *
 * @param {OthelloState} state
 * @returns {[number, number]}
 */
export function discCounts(state) {
  return [popcount2(state.bb[0], state.bb[1]), popcount2(state.bb[2], state.bb[3])];
}

/**
 * Does `seat` have at least one legal placement?
 *
 * @param {OthelloState} state
 * @param {number} seat
 * @returns {boolean}
 */
export function hasPlacement(state, seat) {
  genMoves(state.bb[seat * 2], state.bb[seat * 2 + 1], state.bb[(1 - seat) * 2], state.bb[(1 - seat) * 2 + 1]);
  return (_ra | _rb) !== 0;
}

/**
 * Sorted canonical names of `seat`'s legal placements. Empty when the seat
 * has none (then `pass` is the only legal action) or the game is over.
 *
 * @param {OthelloState} state
 * @param {number} seat
 * @returns {string[]}
 */
export function legalPlacements(state, seat) {
  if (state.status !== 'playing') return [];
  genMoves(state.bb[seat * 2], state.bb[seat * 2 + 1], state.bb[(1 - seat) * 2], state.bb[(1 - seat) * 2 + 1]);
  const rA = _ra;
  const rB = _rb;
  if ((rA | rB) === 0) return [];
  return bitsOf(rA, rB).map((sq) => nameOf(sq.col, sq.row)).sort();
}

/**
 * The game is over exactly when the board is full or neither side has a
 * legal placement.
 *
 * @param {OthelloState} state
 * @returns {boolean}
 */
export function isOver(state) {
  if (state.discs >= 64) return true;
  return !hasPlacement(state, 0) && !hasPlacement(state, 1);
}

/**
 * Apply a placement and return a fresh state. Pure: the input is never
 * mutated. The turn always passes to the other seat; the game ends when the
 * board is full or neither side can place after the move.
 *
 * @param {OthelloState} state
 * @param {number} seat
 * @param {number} col Zero-based file index.
 * @param {number} row Zero-based rank index.
 * @returns {OthelloState}
 * @throws {GauntletRuleError} when the game is over, it is not the seat's
 *   turn, the square is occupied, or the placement brackets nothing.
 */
export function applyPlacement(state, seat, col, row) {
  if (state.status !== 'playing') {
    throw new GauntletRuleError('the game is over');
  }
  if (seat !== state.toMove) {
    throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
  }
  if (col < 0 || col > 7 || row < 0 || row > 7) {
    throw new GauntletRuleError(`${JSON.stringify(nameOf(col, row))} is not a square on the board`);
  }
  const bit = row * 8 + col;
  const pA = bit < 32 ? 1 << bit : 0;
  const pB = bit < 32 ? 0 : 1 << (bit - 32);
  const mA = state.bb[seat * 2];
  const mB = state.bb[seat * 2 + 1];
  const oA = state.bb[(1 - seat) * 2];
  const oB = state.bb[(1 - seat) * 2 + 1];
  if (((mA & pA) | (mB & pB)) !== 0 || ((oA & pA) | (oB & pB)) !== 0) {
    throw new GauntletRuleError(`${nameOf(col, row)} is already occupied`);
  }
  flipsFor(mA, mB, oA, oB, col, row);
  const fA = _fa;
  const fB = _fb;
  if ((fA | fB) === 0) {
    throw new GauntletRuleError(`${nameOf(col, row)} brackets no opponent discs`);
  }
  const bb = state.bb.slice();
  bb[seat * 2] = (mA | pA | fA) >>> 0;
  bb[seat * 2 + 1] = (mB | pB | fB) >>> 0;
  bb[(1 - seat) * 2] = (oA & ~fA) >>> 0;
  bb[(1 - seat) * 2 + 1] = (oB & ~fB) >>> 0;
  const discs = state.discs + 1;
  const next = {
    bb,
    toMove: 1 - seat,
    status: /** @type {'playing' | 'over'} */ ('playing'),
    discs,
    history: state.history.concat(nameOf(col, row)),
    openingPlies: state.openingPlies,
    agentSeat: state.agentSeat,
  };
  next.status = isOver(next) ? 'over' : 'playing';
  return next;
}

/**
 * Apply a pass. Legal only when the seat genuinely has no placement — pass
 * is the only action available then. The other seat always has a placement
 * afterwards (otherwise the game would already be over).
 *
 * @param {OthelloState} state
 * @param {number} seat
 * @returns {OthelloState}
 * @throws {GauntletRuleError} when the game is over, it is not the seat's
 *   turn, or the seat has a legal placement.
 */
export function applyPass(state, seat) {
  if (state.status !== 'playing') {
    throw new GauntletRuleError('the game is over');
  }
  if (seat !== state.toMove) {
    throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
  }
  if (hasPlacement(state, seat)) {
    throw new GauntletRuleError('you have a legal placement, so you cannot pass');
  }
  if (!hasPlacement(state, 1 - seat)) {
    throw new GauntletRuleError('neither side can place, so the game is over');
  }
  return {
    bb: state.bb.slice(),
    toMove: 1 - seat,
    status: 'playing',
    discs: state.discs,
    history: state.history.concat('pass'),
    openingPlies: state.openingPlies,
    agentSeat: state.agentSeat,
  };
}

/**
 * Perft from `state`: leaf counts of the placement tree `depth` plies deep.
 * Convention (the one the published counts assume): a forced pass consumes a
 * ply like a real move; a terminal position counts as one leaf. Passes never
 * occur within the published depths from the standard opening.
 *
 * @param {OthelloState} state
 * @param {number} depth
 * @returns {number}
 */
export function perft(state, depth) {
  return countPlies(
    state.toMove,
    state.bb[state.toMove * 2],
    state.bb[state.toMove * 2 + 1],
    state.bb[(1 - state.toMove) * 2],
    state.bb[(1 - state.toMove) * 2 + 1],
    depth
  );
}

/**
 * @param {number} seat
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @param {number} depth
 * @returns {number}
 */
function countPlies(seat, mA, mB, oA, oB, depth) {
  if (depth === 0) return 1;
  genMoves(mA, mB, oA, oB);
  const rA = _ra;
  const rB = _rb;
  if ((rA | rB) === 0) {
    // No placement: the side to move passes (consuming a ply) or, if the
    // opponent cannot place either, the game is over and this is a leaf.
    genMoves(oA, oB, mA, mB);
    if ((_ra | _rb) === 0) return 1;
    return countPlies(1 - seat, oA, oB, mA, mB, depth - 1);
  }
  if (depth === 1) return popcount2(rA, rB);
  let n = 0;
  for (const sq of bitsOf(rA, rB)) {
    flipsFor(mA, mB, oA, oB, sq.col, sq.row);
    const fA = _fa;
    const fB = _fb;
    const bit = sq.row * 8 + sq.col;
    const pA = bit < 32 ? 1 << bit : 0;
    const pB = bit < 32 ? 0 : 1 << (bit - 32);
    n += countPlies(
      1 - seat,
      (oA & ~fA) >>> 0,
      (oB & ~fB) >>> 0,
      (mA | pA | fA) >>> 0,
      (mB | pB | fB) >>> 0,
      depth - 1
    );
  }
  return n;
}
