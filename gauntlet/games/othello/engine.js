/**
 * The Othello engine: negamax with alpha-beta and iterative deepening under
 * a fixed node budget, plus a small transposition table. Deterministic and
 * clock-free — the budget is counted in nodes visited, never in wall time,
 * so a run replays exactly.
 *
 * Evaluation, from the side to move's perspective: a positional term from a
 * static square table (corners strongly positive, corner-adjacent squares
 * negative), plus a mobility term, plus a raw disc-differential term that
 * only switches on near the end of the game when discs stop being deceptive.
 * Terminal positions score the final disc margin directly.
 *
 * Iterative deepening: search depth 1, 2, 3, ... until the node budget is
 * exhausted, keeping the best move of the last fully completed depth. A
 * depth pass aborted by the budget is discarded whole, so the returned move
 * is always the result of a complete, deterministic search.
 *
 * Tie-breaks are deterministic: among equally-scoring root moves the engine
 * plays the one with the highest static square priority (the order root
 * moves are searched in), and never consults randomness or a clock.
 *
 * Pure JS, no `node:*`.
 *
 * @module
 */

import { movesBB, flipsBB, popcount2, bitsOf, nameOf } from './rules.js';

/**
 * Static positional weights indexed by square (row * 8 + col, row 0 = rank
 * 1 at the top). The table is symmetric under rotation and reflection, so
 * the top-left orientation loses nothing.
 */
const WEIGHTS = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, -1, -1, -1, -1, -2, 10,
  5, -2, -1, 0, 0, -1, -2, 5,
  5, -2, -1, 0, 0, -1, -2, 5,
  10, -2, -1, -1, -1, -1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
];

/** A terminal score is the disc margin scaled past any heuristic value. */
const MARGIN_SCALE = 10000;

/** Squares in static priority order: corners first, then by weight. */
const ORDER = (() => {
  /** @param {number} sq */
  const prio = (sq) => WEIGHTS[sq] + ([0, 7, 56, 63].includes(sq) ? 1000 : 0);
  return Array.from({ length: 64 }, (_, sq) => sq).sort((p, q) => prio(q) - prio(p));
})();

/** Thrown to unwind a depth pass whose subtree blew the node budget. */
class BudgetAbort extends Error {}

/** Module-level node counter; `chooseMove` is synchronous and never re-enters. */
let _nodes = 0;
let _budget = 0;

/**
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @param {number} empties
 * @returns {number} Heuristic score from the mover's perspective.
 */
function evaluate(mA, mB, oA, oB, empties) {
  let pos = 0;
  for (const sq of bitsOf(mA, mB)) pos += WEIGHTS[sq.row * 8 + sq.col];
  for (const sq of bitsOf(oA, oB)) pos -= WEIGHTS[sq.row * 8 + sq.col];
  const mine = movesBB(mA, mB, oA, oB);
  const theirs = movesBB(oA, oB, mA, mB);
  let score = pos + 10 * (popcount2(mine.a, mine.b) - popcount2(theirs.a, theirs.b));
  if (empties <= 12) {
    score += 25 * (popcount2(mA, mB) - popcount2(oA, oB));
  }
  return score;
}

/**
 * @typedef {object} TtEntry
 * @property {number} depth Remaining depth the score was searched to.
 * @property {number} flag 0 exact, 1 lower bound, 2 upper bound.
 * @property {number} score
 */

/**
 * Negamax with alpha-beta. `_nodes` counts entries; the budget aborts the
 * current pass. A pass consumes a ply of depth, so the recursion always
 * terminates.
 *
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @param {number} empties Empty squares remaining.
 * @param {number} depth Remaining depth.
 * @param {number} ply Plies from the root.
 * @param {number} alpha
 * @param {number} beta
 * @param {Map<string, TtEntry>} tt
 * @returns {number}
 * @throws {BudgetAbort} when the node budget is exhausted.
 */
function search(mA, mB, oA, oB, empties, depth, ply, alpha, beta, tt) {
  _nodes++;
  if (_nodes > _budget) throw new BudgetAbort();
  const moves = movesBB(mA, mB, oA, oB);
  if ((moves.a | moves.b) === 0) {
    const oppMoves = movesBB(oA, oB, mA, mB);
    if ((oppMoves.a | oppMoves.b) === 0) {
      // Terminal: final disc margin from the mover's perspective.
      const mine = popcount2(mA, mB);
      const theirs = popcount2(oA, oB);
      return (mine - theirs) * MARGIN_SCALE;
    }
    // The mover sits out; the pass costs a ply of depth.
    return -search(oA, oB, mA, mB, empties, depth - 1, ply + 1, -beta, -alpha, tt);
  }
  if (depth <= 0 || empties <= 0) {
    return evaluate(mA, mB, oA, oB, empties);
  }
  const key = `${mA},${mB},${oA},${oB}`;
  const entry = tt.get(key);
  let a = alpha;
  if (entry !== undefined && entry.depth >= depth) {
    if (entry.flag === 0) return entry.score;
    if (entry.flag === 1 && entry.score >= beta) return entry.score;
    if (entry.flag === 2 && entry.score <= a) return entry.score;
  }
  let best = -Infinity;
  // Search in static priority order; recurse over a copy of the ordered
  // squares so module temporaries cannot clobber the iteration.
  const ordered = orderedSquares(moves.a, moves.b);
  for (const sq of ordered) {
    const child = childAfter(mA, mB, oA, oB, sq);
    const score = -search(child.moverA, child.moverB, child.oppA, child.oppB, empties - 1, depth - 1, ply + 1, -beta, -a, tt);
    if (score > best) best = score;
    if (best > a) a = best;
    if (a >= beta) break;
  }
  const flag = best <= alpha ? 2 : best >= beta ? 1 : 0;
  tt.set(key, { depth, flag, score: best });
  return best;
}

/**
 * Squares of a limb pair in static priority order.
 *
 * @param {number} a
 * @param {number} b
 * @returns {{ col: number, row: number, sq: number }[]}
 */
function orderedSquares(a, b) {
  const set = new Set(bitsOf(a, b).map((sq) => sq.row * 8 + sq.col));
  const out = [];
  for (const sq of ORDER) {
    if (set.has(sq)) {
      out.push({ col: sq % 8, row: (sq / 8) | 0, sq });
    }
  }
  return out;
}

/**
 * The position after the mover places at `sq`, in the CHILD's frame: the
 * child's mover is the parent's opponent minus the flipped discs, and the
 * child's opponent is the parent's mover plus the new disc and the flips.
 *
 * @param {number} mA
 * @param {number} mB
 * @param {number} oA
 * @param {number} oB
 * @param {{ col: number, row: number, sq: number }} sq
 * @returns {{ moverA: number, moverB: number, oppA: number, oppB: number }}
 */
function childAfter(mA, mB, oA, oB, sq) {
  const bit = sq.sq;
  const pA = bit < 32 ? 1 << bit : 0;
  const pB = bit < 32 ? 0 : 1 << (bit - 32);
  const flips = flipsBB(mA, mB, oA, oB, sq.col, sq.row);
  return {
    moverA: (oA & ~flips.a) >>> 0,
    moverB: (oB & ~flips.b) >>> 0,
    oppA: (mA | pA | flips.a) >>> 0,
    oppB: (mB | pB | flips.b) >>> 0,
  };
}

/**
 * Choose a placement for the side to move.
 *
 * @param {import('./rules.js').OthelloState} state The game state; side to
 *   move must have at least one legal placement (passing is the caller's job).
 * @param {{ nodeBudget: number }} options Fixed search budget in nodes.
 * @returns {{ move: string, score: number, nodes: number, depth: number }}
 *   The chosen square name, its root score from the last completed depth,
 *   the nodes actually visited, and that completed depth.
 * @throws {Error} when the side to move has no legal placement.
 */
export function chooseMove(state, options) {
  const seat = state.toMove;
  const mA = state.bb[seat * 2];
  const mB = state.bb[seat * 2 + 1];
  const oA = state.bb[(1 - seat) * 2];
  const oB = state.bb[(1 - seat) * 2 + 1];
  const empties = 64 - state.discs;
  const rootLimbs = movesToLimbs(state, seat);
  const rootMoves = orderedSquares(rootLimbs.a, rootLimbs.b);
  if (rootMoves.length === 0) {
    throw new Error('chooseMove: the side to move has no legal placement; play "pass" instead');
  }
  _nodes = 0;
  _budget = Math.max(1, options.nodeBudget);
  const tt = new Map();
  let bestMove = rootMoves[0];
  let bestScore = 0;
  let completedDepth = 0;
  for (let depth = 1; depth <= empties; depth++) {
    let passBest = null;
    let passScore = -Infinity;
    let alpha = -Infinity;
    try {
      for (const sq of rootMoves) {
        const child = childAfter(mA, mB, oA, oB, sq);
        const score = -search(child.moverA, child.moverB, child.oppA, child.oppB, empties - 1, depth - 1, 1, -Infinity, -alpha, tt);
        if (score > passScore) {
          passScore = score;
          passBest = sq;
        }
        if (score > alpha) alpha = score;
      }
    } catch (err) {
      if (err instanceof BudgetAbort) break;
      throw err;
    }
    bestMove = /** @type {{ col: number, row: number, sq: number }} */ (passBest);
    bestScore = passScore;
    completedDepth = depth;
    if (_nodes >= _budget) break;
  }
  return { move: nameOf(bestMove.col, bestMove.row), score: bestScore, nodes: _nodes, depth: completedDepth };
}

/**
 * The side to move's placement bitboard as limbs.
 *
 * @param {import('./rules.js').OthelloState} state
 * @param {number} seat
 * @returns {{ a: number, b: number }}
 */
function movesToLimbs(state, seat) {
  const mv = movesBB(state.bb[seat * 2], state.bb[seat * 2 + 1], state.bb[(1 - seat) * 2], state.bb[(1 - seat) * 2 + 1]);
  return mv;
}
