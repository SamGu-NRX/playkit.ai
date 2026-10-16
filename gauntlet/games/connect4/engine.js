/**
 * The Connect Four engine: depth-limited negamax with alpha-beta, a
 * transposition table, center-first move ordering, seeded tie-breaks, and an
 * exact solver mode for endgame positions (30 or more discs placed).
 *
 * The search works on the two-limb bitboards from `rules.js` as plain numbers
 * (no object allocation per node) and mutates a private copy of the height
 * array with undo, so game states are never touched. Mate scores encode the
 * distance: a win for the side to move in d plies scores WIN_SCORE - d, a
 * loss scores -(WIN_SCORE - d), so faster wins and slower losses outrank
 * their alternatives at every node.
 *
 * Pure JS, no `node:*`. No randomness and no clocks: the only nondeterminism
 * is tie-breaking, which comes from the core RNG seeded by an explicit key.
 *
 * @module
 */

import { nextInt, streamFromSeed } from '../../core/rng.js';
import { bitFor, hasAlignment, legalCols, WIDTH, HEIGHT } from './rules.js';

/** @import { Connect4State } from './rules.js' */

/** Base mate score; distances are at most 42, so scores stay above this. */
export const WIN_SCORE = 1000000;
const MATE_BOUND = WIN_SCORE - 256;

/** Center-first column order: the search tries and the root prefers columns 3,2,4,1,5,0,6. */
const ORDER = [3, 2, 4, 1, 5, 0, 6];

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

/** Precomputed column bits, [col][row] as { a, b }.
 *
 * @type {Array<{ a: number, b: number }[]>}
 */
const BITS = [];
for (let col = 0; col < WIDTH; col++) {
  BITS.push(
    Array.from({ length: HEIGHT }, (_, row) => bitFor(col, row))
  );
}

/**
 * Popcount of up to 28-bit limb values via a nibble table.
 *
 * @param {number} x
 * @returns {number}
 */
function popcount(x) {
  let n = 0;
  while (x !== 0) {
    x &= x - 1;
    n++;
  }
  return n;
}

/**
 * The 69 four-cell windows: 24 horizontal, 21 vertical, 12+12 diagonal.
 * Stored as limb pairs. Used by the evaluator to count immediate threats.
 *
 * @type {Array<{ a: number, b: number }>}
 */
const WINDOWS = [];
for (let row = 0; row < 6; row++) {
  for (let col = 0; col <= 3; col++) {
    WINDOWS.push(winBits(col, row, 1, 0));
  }
}
for (let col = 0; col < 7; col++) {
  for (let row = 0; row <= 2; row++) {
    WINDOWS.push(winBits(col, row, 0, 1));
  }
}
for (let row = 0; row <= 2; row++) {
  for (let col = 0; col <= 3; col++) {
    WINDOWS.push(winBits(col, row, 1, 1));
  }
}
for (let row = 3; row < 6; row++) {
  for (let col = 0; col <= 3; col++) {
    WINDOWS.push(winBits(col, row, 1, -1));
  }
}

/**
 * @param {number} col
 * @param {number} row
 * @param {number} dc
 * @param {number} dr
 * @returns {{ a: number, b: number }}
 */
function winBits(col, row, dc, dr) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 4; i++) {
    const bit = bitFor(col + dc * i, row + dr * i);
    a |= bit.a;
    b |= bit.b;
  }
  return { a, b };
}

/** Center-column stones for seat bits. */
const CENTER_MASK = (() => {
  let a = 0;
  for (let row = 0; row < HEIGHT; row++) a |= bitFor(3, row).a;
  return a;
})();

/**
 * Static evaluation, from the side to move's perspective. Counts immediate
 * winning squares (open three-windows) for both sides and center-column
 * control. Never called on terminal positions.
 *
 * @param {number} meA Side-to-move bitboard, low limb.
 * @param {number} meB
 * @param {number} opA
 * @param {number} opB
 * @param {number} maskA
 * @param {number} maskB
 * @returns {number}
 */
function evaluate(meA, meB, opA, opB, maskA, maskB) {
  let mine = 0;
  let theirs = 0;
  for (let i = 0; i < WINDOWS.length; i++) {
    const w = WINDOWS[i];
    const inMe = popcount(meA & w.a) + popcount(meB & w.b);
    if (inMe === 3 && popcount(maskA & w.a) + popcount(maskB & w.b) === 3) {
      mine++;
      continue;
    }
    if (inMe === 0) {
      const inOp = popcount(opA & w.a) + popcount(opB & w.b);
      if (inOp === 3 && popcount(maskA & w.a) + popcount(maskB & w.b) === 3) {
        theirs++;
      }
    }
  }
  return 16 * (mine - theirs) + 3 * (popcount(meA & CENTER_MASK) - popcount(opA & CENTER_MASK));
}

/**
 * @typedef {object} TtEntry
 * @property {number} depth
 * @property {number} flag
 * @property {number} score Ply-adjusted (distance-encoded) score.
 */

/**
 * Negamax with alpha-beta over the two-limb bitboards. `heights` is mutated
 * and restored; callers pass a private copy. Fail-soft.
 *
 * @param {number} meA Side-to-move bitboard, low limb.
 * @param {number} meB
 * @param {number} opA Opponent bitboard, low limb.
 * @param {number} opB
 * @param {number} maskA Occupied cells, low limb.
 * @param {number} maskB
 * @param {number[]} heights Private mutable copy of column heights.
 * @param {number} discs Discs placed so far.
 * @param {number} depth Plies left to search.
 * @param {number} ply Plies from the search root.
 * @param {number} alpha
 * @param {number} beta
 * @param {Map<string, TtEntry>} tt
 * @returns {number} Score for the side to move.
 */
function search(meA, meB, opA, opB, maskA, maskB, heights, discs, depth, ply, alpha, beta, tt) {
  if (discs === WIDTH * HEIGHT) return 0; // full board: draw

  // Immediate win for the side to move: one ply.
  for (let i = 0; i < WIDTH; i++) {
    const col = ORDER[i];
    const row = heights[col];
    if (row >= HEIGHT) continue;
    const bit = BITS[col][row];
    if (hasAlignment({ a: meA | bit.a, b: meB | bit.b })) {
      return WIN_SCORE - (ply + 1);
    }
  }

  if (depth <= 0) return evaluate(meA, meB, opA, opB, maskA, maskB);

  const key = `${meA},${meB},${maskA},${maskB}`;
  const entry = tt.get(key);
  if (entry !== undefined && entry.depth >= depth) {
    let s = entry.score;
    if (s > MATE_BOUND) s -= ply;
    else if (s < -MATE_BOUND) s += ply;
    if (entry.flag === TT_EXACT) return s;
    if (entry.flag === TT_LOWER && s >= beta) return s;
    if (entry.flag === TT_UPPER && s <= alpha) return s;
  }

  const alpha0 = alpha;
  let best = -Infinity;
  let flag = TT_UPPER;
  for (let i = 0; i < WIDTH; i++) {
    const col = ORDER[i];
    const row = heights[col];
    if (row >= HEIGHT) continue;
    const bit = BITS[col][row];
    heights[col] = row + 1;
    const score = -search(
      opA,
      opB,
      meA | bit.a,
      meB | bit.b,
      maskA | bit.a,
      maskB | bit.b,
      heights,
      discs + 1,
      depth - 1,
      ply + 1,
      -beta,
      -alpha,
      tt
    );
    heights[col] = row;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      flag = TT_LOWER;
      break;
    }
  }
  if (best > alpha0 && flag !== TT_LOWER) flag = TT_EXACT;

  let storeScore = best;
  if (storeScore > MATE_BOUND) storeScore += ply;
  else if (storeScore < -MATE_BOUND) storeScore -= ply;
  tt.set(key, { depth, flag, score: storeScore });
  return best;
}

/**
 * Unpack a game state into search primitives and a private heights copy.
 *
 * @param {Connect4State} state
 * @returns {{ meA: number, meB: number, opA: number, opB: number, maskA: number, maskB: number, heights: number[], discs: number, mover: number }}
 */
function unpack(state) {
  const mover = state.toMove;
  return {
    meA: state.bb[mover * 2],
    meB: state.bb[mover * 2 + 1],
    opA: state.bb[(1 - mover) * 2],
    opB: state.bb[(1 - mover) * 2 + 1],
    maskA: state.bb[0] | state.bb[2],
    maskB: state.bb[1] | state.bb[3],
    heights: state.heights.slice(),
    discs: state.discs,
    mover,
  };
}

/**
 * @typedef {object} MoveChoice
 * @property {number} col Zero-based column index.
 * @property {number} score Root score for the side to move.
 * @property {number} nodes Nodes searched.
 */

/**
 * Pick a move for the side to move at a fixed depth. Ties are broken
 * uniformly at random from the RNG stream named by `seedKey`, or — when no
 * key is given — by taking the most central column among the best moves.
 *
 * @param {Connect4State} state Non-terminal state.
 * @param {{ depth: number, seedKey?: string | null }} options
 * @returns {MoveChoice}
 * @throws {Error} when the board is full.
 */
export function chooseMove(state, options) {
  const { depth } = options;
  const u = unpack(state);
  if (u.discs === WIDTH * HEIGHT) throw new Error('chooseMove: the board is full');

  // Immediate wins need no search.
  const winning = [];
  for (const col of legalCols(state)) {
    const bit = BITS[col][u.heights[col]];
    if (hasAlignment({ a: u.meA | bit.a, b: u.meB | bit.b })) winning.push(col);
  }
  if (winning.length > 0) {
    return { col: breakTie(winning, options.seedKey), score: WIN_SCORE - 1, nodes: 0 };
  }

  const tt = new Map();
  let alpha = -Infinity;
  const scores = new Map();
  for (let i = 0; i < WIDTH; i++) {
    const col = ORDER[i];
    const row = u.heights[col];
    if (row >= HEIGHT) continue;
    const bit = BITS[col][row];
    u.heights[col] = row + 1;
    const score = -search(
      u.opA,
      u.opB,
      u.meA | bit.a,
      u.meB | bit.b,
      u.maskA | bit.a,
      u.maskB | bit.b,
      u.heights,
      u.discs + 1,
      depth - 1,
      1,
      -Infinity,
      -alpha,
      tt
    );
    u.heights[col] = row;
    scores.set(col, score);
    if (score > alpha) alpha = score;
  }
  const best = Math.max(...scores.values());
  const tied = [...scores.entries()].filter(([, s]) => s === best).map(([c]) => c);
  return { col: breakTie(tied, options.seedKey), score: best, nodes: tt.size };
}

/**
 * Seeded uniform tie-break, or most-central-first when no key is given.
 *
 * @param {number[]} cols
 * @param {string | null | undefined} seedKey
 * @returns {number}
 */
function breakTie(cols, seedKey) {
  if (cols.length === 1) return cols[0];
  if (seedKey) {
    const stream = streamFromSeed(seedKey);
    return cols[nextInt(stream.getState(), 0, cols.length - 1).value];
  }
  let bestCol = cols[0];
  for (const col of cols) {
    if (Math.abs(col - 3) < Math.abs(bestCol - 3)) bestCol = col;
  }
  return bestCol;
}

/**
 * @typedef {object} ExactValue
 * @property {'win' | 'loss' | 'draw' | 'unproven'} verdict Game-theoretic value
 *   for the side to move. 'draw' only on a full-depth solve; 'unproven' only
 *   when a horizon was supplied and no forced win or loss fits inside it.
 * @property {number | null} plies Distance in plies until the winning stone
 *   is placed (from the winning side's perspective); null on a draw or an
 *   unproven value.
 */

/**
 * Exact game-theoretic value with distance for the side to move.
 *
 * Without a horizon this is a full-width solve: correct at any depth but only
 * practical near the endgame. With a horizon the search iteratively deepens
 * and proves any forced win or loss that fits within the horizon (mate
 * distances are exact within it); positions with no proof inside the horizon
 * come back as 'unproven'.
 *
 * @param {Connect4State} state Non-terminal state.
 * @param {{ horizon?: number }} [options] Horizon-limited mode; omit for a
 *   full-depth solve.
 * @returns {ExactValue}
 * @throws {Error} when the board is full.
 */
export function solveExact(state, options) {
  const u = unpack(state);
  if (u.discs === WIDTH * HEIGHT) throw new Error('solveExact: the board is full');
  if (options?.horizon === undefined) {
    const score = search(
      u.meA,
      u.meB,
      u.opA,
      u.opB,
      u.maskA,
      u.maskB,
      u.heights,
      u.discs,
      WIDTH * HEIGHT - u.discs,
      0,
      -Infinity,
      Infinity,
      new Map()
    );
    return decodeExact(score);
  }
  const horizon = Math.min(options.horizon, WIDTH * HEIGHT - u.discs);
  // Wins and losses are detected at the depth they fit inside, so odd
  // depths (win distances from the mover's perspective are odd) suffice.
  for (let depth = 3; depth <= horizon; depth += 2) {
    const score = search(
      u.meA,
      u.meB,
      u.opA,
      u.opB,
      u.maskA,
      u.maskB,
      u.heights,
      u.discs,
      depth,
      0,
      -Infinity,
      Infinity,
      new Map()
    );
    if (score > MATE_BOUND) return { verdict: 'win', plies: WIN_SCORE - score };
    if (score < -MATE_BOUND) return { verdict: 'loss', plies: WIN_SCORE + score };
  }
  return { verdict: 'unproven', plies: null };
}

/**
 * @param {number} score
 * @returns {ExactValue}
 */
function decodeExact(score) {
  if (score > MATE_BOUND) {
    return { verdict: 'win', plies: WIN_SCORE - score };
  }
  if (score < -MATE_BOUND) {
    return { verdict: 'loss', plies: WIN_SCORE + score };
  }
  return { verdict: 'draw', plies: null };
}

/**
 * Best exact move for the side to move: maximizes the game-theoretic score,
 * so it wins as fast as it can and, when losing, resists as long as it can.
 * Used by the forced-win tier's strongest-engine opponent.
 *
 * @param {Connect4State} state Non-terminal state.
 * @param {string | null} [seedKey] Seeded tie-break among equally optimal
 *   moves; most-central when omitted.
 * @returns {MoveChoice & ExactValue}
 * @throws {Error} when the board is full.
 */
export function chooseExactMove(state, seedKey) {
  const u = unpack(state);
  if (u.discs === WIDTH * HEIGHT) throw new Error('chooseExactMove: the board is full');

  // Immediate wins need no search.
  const winning = [];
  for (const col of legalCols(state)) {
    const bit = BITS[col][u.heights[col]];
    if (hasAlignment({ a: u.meA | bit.a, b: u.meB | bit.b })) winning.push(col);
  }
  if (winning.length > 0) {
    return {
      col: breakTie(winning, seedKey ?? null),
      score: WIN_SCORE - 1,
      nodes: 0,
      verdict: 'win',
      plies: 1,
    };
  }

  const tt = new Map();
  const scores = new Map();
  let alpha = -Infinity;
  // Mate distances are exact within this horizon; beyond it the move choice
  // degrades to heuristic best, which is all the opponent contract needs.
  const depth = Math.min(WIDTH * HEIGHT - u.discs - 1, 21);
  for (let i = 0; i < WIDTH; i++) {
    const col = ORDER[i];
    const row = u.heights[col];
    if (row >= HEIGHT) continue;
    const bit = BITS[col][row];
    u.heights[col] = row + 1;
    const score = -search(
      u.opA,
      u.opB,
      u.meA | bit.a,
      u.meB | bit.b,
      u.maskA | bit.a,
      u.maskB | bit.b,
      u.heights,
      u.discs + 1,
      depth - 1,
      1,
      -Infinity,
      -alpha,
      tt
    );
    u.heights[col] = row;
    scores.set(col, score);
    if (score > alpha) alpha = score;
  }
  const best = Math.max(...scores.values());
  const tied = [...scores.entries()].filter(([, s]) => s === best).map(([c]) => c);
  const value = decodeExact(best);
  return { col: breakTie(tied, seedKey ?? null), score: best, nodes: tt.size, ...value };
}

/**
 * Columns in which the side to move wins immediately. Used by the game's
 * seeded-opening filter.
 *
 * @param {Connect4State} state
 * @returns {number[]}
 */
export function immediateWinCols(state) {
  const u = unpack(state);
  const cols = [];
  for (const col of legalCols(state)) {
    const bit = BITS[col][u.heights[col]];
    if (hasAlignment({ a: u.meA | bit.a, b: u.meB | bit.b })) cols.push(col);
  }
  return cols;
}
