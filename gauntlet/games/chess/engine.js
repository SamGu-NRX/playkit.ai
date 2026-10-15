/**
 * The deterministic built-in chess engine: iterative-deepening alpha-beta with
 * a capture-only quiescence step, material + piece-square-table evaluation,
 * MVV-LVA move ordering, and seeded root tie-breaking. Runs on chess.js 1.4.0
 * internals through one cast helper: the public `move()` path is an order of
 * magnitude slower, which is fatal inside a search.
 *
 * No `node:*` imports. All functions are pure in the gauntlet sense: they may
 * mutate the passed chess.js instance while computing (and undo every change),
 * but never touch game state.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { shuffle } from '../../core/rng.js';

/** @import { RngState } from '../../core/rng.js' */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * A chess.js 1.4.0 internal move: 0x88 numeric squares, lowercase promotion
 * letter, flag bits (1 capture, 2 big pawn, 4 ep capture, 8 promotion,
 * 16 null, 32 kingside castle, 64 queenside castle).
 *
 * @typedef {object} InternalMove
 * @property {string} color
 * @property {number} from 0x88 square.
 * @property {number} to 0x88 square.
 * @property {string} piece
 * @property {string} [captured]
 * @property {string} [promotion]
 * @property {number} flags
 */

/**
 * The subset of chess.js 1.4.0 internals the fast path uses. The public class
 * types these members private, so every access goes through `internals()`.
 *
 * @typedef {object} FastChess
 * @property {(opts?: { legal?: boolean, piece?: string }) => InternalMove[]} _moves
 * @property {(move: InternalMove) => void} _makeMove
 * @property {() => InternalMove | null} _undoMove
 * @property {(move: InternalMove, moves: InternalMove[]) => string} _moveToSan
 * @property {number} _halfMoves
 * @property {Array<{ type: string, color: string } | undefined>} _board
 * @property {'w' | 'b'} _turn
 * @property {() => string} fen
 * @property {() => 'w' | 'b'} turn
 * @property {() => boolean} isCheck
 * @property {() => boolean} isInsufficientMaterial
 */

/**
 * Cast a public chess.js instance to the version-pinned fast internals.
 * The one place a private access escapes the typechecker.
 *
 * @param {Chess} chess
 * @returns {FastChess}
 */
export function internals(chess) {
  return /** @type {FastChess} */ (/** @type {unknown} */ (chess));
}

/**
 * Build a position from a FEN.
 *
 * @param {string} fen
 * @returns {Chess}
 */
export function createPosition(fen) {
  return new Chess(fen);
}

/**
 * Convert a numeric 0x88 square (a8 = 0, h1 = 119) to algebraic notation.
 *
 * @param {number} square
 * @returns {string}
 */
export function squareToAlgebraic(square) {
  return 'abcdefgh'[square & 0xf] + String(8 - (square >> 4));
}

/**
 * Convert an internal move to UCI (from, to, lowercase promotion suffix).
 *
 * @param {InternalMove} move
 * @returns {string}
 */
export function moveToUci(move) {
  return squareToAlgebraic(move.from) + squareToAlgebraic(move.to) + (move.promotion ?? '');
}

/**
 * All legal moves in UCI, sorted (the canonical action list).
 *
 * @param {Chess} chess
 * @returns {string[]}
 */
export function legalUcis(chess) {
  return internals(chess)
    ._moves({ legal: true })
    .map(moveToUci)
    .sort();
}

/**
 * Find the legal internal move matching a UCI string, or null.
 *
 * @param {Chess} chess
 * @param {string} uci
 * @returns {InternalMove | null}
 */
export function matchUci(chess, uci) {
  for (const move of internals(chess)._moves({ legal: true })) {
    if (moveToUci(move) === uci) return move;
  }
  return null;
}

/**
 * Replay a UCI move list through the fast path, matching each UCI against the
 * legal internal moves at every ply (no public re-validation). Throws on any
 * illegal move — callers own the legality contract.
 *
 * @param {string} startFen
 * @param {readonly string[]} uciMoves
 * @returns {Chess}
 */
export function replayUci(startFen, uciMoves) {
  const chess = createPosition(startFen);
  for (const uci of uciMoves) {
    const move = matchUci(chess, uci);
    if (!move) {
      throw new Error(`illegal move "${uci}" after ${uciMoves.indexOf(uci)} plies of ${startFen}`);
    }
    internals(chess)._makeMove(move);
  }
  return chess;
}

// ---------------------------------------------------------------------------
// Evaluation: material + piece-square tables (white perspective, a8-first).
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} Material values in centipawns. */
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** @type {Record<string, number[]>} piece-square tables, index 0 = a8. */
const PSTS = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
};

const KING_MIDDLE = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];

const KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

/** Below this much total non-pawn material (both sides), the endgame king table applies. */
const ENDGAME_MATERIAL = 2400;

/**
 * White-perspective static evaluation in centipawns (material + PSTs).
 *
 * @param {Chess} chess
 * @returns {number}
 */
export function evaluateWhite(chess) {
  const fast = internals(chess);
  const board = fast._board;
  let whiteMaterial = 0;
  let blackMaterial = 0;
  let score = 0;
  for (let square = 0; square <= 119; square++) {
    if (square & 0x88) {
      square += 7;
      continue;
    }
    const piece = board[square];
    if (!piece) continue;
    const row = square >> 4;
    const file = square & 7;
    const white = piece.color === 'w';
    // Black pieces mirror the table vertically.
    const index = white ? row * 8 + file : (7 - row) * 8 + file;
    const value = PIECE_VALUES[piece.type];
    let table = piece.type === 'k' ? KING_MIDDLE : PSTS[piece.type];
    if (piece.type !== 'p' && piece.type !== 'k') {
      if (white) whiteMaterial += value;
      else blackMaterial += value;
    }
    if (piece.type === 'k') {
      table = whiteMaterial + blackMaterial <= ENDGAME_MATERIAL ? KING_END : KING_MIDDLE;
    }
    score += white ? value + table[index] : -(value + table[index]);
  }
  return score;
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/** Mate scores are distance-adjusted: mate in one ply from the root is exactly MATE. */
export const MATE = 999999;

/**
 * Search limits. The node budget makes the engine deterministic under the
 * sandbox CPU quota: when the budget runs out mid-iteration, the best move
 * from the last completed depth is kept. `depth` is unused by the plain
 * quiescence evaluator.
 *
 * @typedef {object} EngineParams
 * @property {number} [depth] Iterative-deepening maximum depth.
 * @property {number} nodeBudget Hard cap on searched nodes.
 * @property {number} [quiescenceMaxPlies] Capture-only extension depth (default 8).
 */

/**
 * @typedef {object} EngineResult
 * @property {string} uci Best move in UCI.
 * @property {number} score Centipawns from the mover's perspective.
 * @property {number} depth Completed search depth.
 * @property {number} nodes Nodes searched.
 */

/**
 * @typedef {object} SearchBudget
 * @property {number} nodes
 * @property {number} limit
 * @property {boolean} aborted
 */

/**
 * MVV-LVA-ish ordering score: captures by victim value minus attacker value,
 * promotions first. Deterministic.
 *
 * @param {InternalMove} move
 * @returns {number}
 */
function orderScore(move) {
  let score = 0;
  if (move.captured) {
    score += 10 * PIECE_VALUES[move.captured] - PIECE_VALUES[move.piece];
  }
  if (move.promotion) {
    score += PIECE_VALUES[move.promotion];
  }
  return score;
}

/**
 * @param {InternalMove[]} moves
 * @returns {InternalMove[]}
 */
function orderMoves(moves) {
  return moves
    .map((move, index) => ({ move, key: orderScore(move), index }))
    .sort((a, b) => b.key - a.key || a.index - b.index)
    .map((entry) => entry.move);
}

/**
 * @param {number} limit
 * @returns {SearchBudget}
 */
function newBudget(limit) {
  return { nodes: 0, limit, aborted: false };
}

/**
 * Capture-only quiescence with stand-pat. Side-to-move perspective.
 *
 * @param {Chess} chess
 * @param {number} alpha
 * @param {number} beta
 * @param {number} pliesLeft
 * @param {SearchBudget} budget
 * @returns {number}
 */
function quiescence(chess, alpha, beta, pliesLeft, budget) {
  budget.nodes++;
  if (budget.nodes > budget.limit) {
    budget.aborted = true;
    return evaluateSideToMove(chess);
  }
  const stand = evaluateSideToMove(chess);
  if (pliesLeft <= 0 || stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  const captures = orderMoves(
    internals(chess)
      ._moves({ legal: true })
      .filter((move) => move.captured || move.promotion)
  );
  let best = stand;
  for (const move of captures) {
    internals(chess)._makeMove(move);
    const score = -quiescence(chess, -beta, -alpha, pliesLeft - 1, budget);
    internals(chess)._undoMove();
    if (budget.aborted) return best;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Static evaluation from the side to move's perspective.
 *
 * @param {Chess} chess
 * @returns {number}
 */
function evaluateSideToMove(chess) {
  const white = evaluateWhite(chess);
  return chess.turn() === 'w' ? white : -white;
}

/**
 * Negamax alpha-beta over the full legal move list. Terminal checks inside
 * the tree are deliberately cheap: no repetition or insufficient-material
 * probes (the node budget makes them moot; game-level adjudication owns the
 * endings).
 *
 * @param {Chess} chess
 * @param {number} depth
 * @param {number} alpha
 * @param {number} beta
 * @param {number} ply
 * @param {SearchBudget} budget
 * @param {number} qPlies
 * @returns {number}
 */
function negamax(chess, depth, alpha, beta, ply, budget, qPlies) {
  budget.nodes++;
  if (budget.nodes > budget.limit) {
    budget.aborted = true;
    return evaluateSideToMove(chess);
  }
  const moves = internals(chess)._moves({ legal: true });
  if (moves.length === 0) {
    return chess.isCheck() ? -(MATE - ply + 1) : 0;
  }
  if (depth <= 0) {
    return quiescence(chess, alpha, beta, qPlies, budget);
  }
  let best = -Infinity;
  for (const move of orderMoves(moves)) {
    internals(chess)._makeMove(move);
    const score = -negamax(chess, depth - 1, -beta, -alpha, ply + 1, budget, qPlies);
    internals(chess)._undoMove();
    if (budget.aborted) return best === -Infinity ? evaluateSideToMove(chess) : best;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Search the position for the best move. Root moves are shuffled with the
 * repo RNG so score ties break by seed, and iterative deepening keeps the
 * best move from the deepest completed iteration.
 *
 * @param {Chess} chess Position to search (left unchanged).
 * @param {EngineParams} params Depth and node budget.
 * @param {RngState} rngState Seeded RNG state for root tie-breaking.
 * @returns {EngineResult}
 */
export function bestMove(chess, params, rngState) {
  const fast = internals(chess);
  const rootMoves = fast._moves({ legal: true });
  if (rootMoves.length === 0) {
    throw new Error('bestMove: no legal moves in the position');
  }
  const depth = params.depth ?? 1;
  const shuffled = shuffle(rngState, rootMoves).value;
  const qPlies = params.quiescenceMaxPlies ?? 8;
  const budget = newBudget(params.nodeBudget);
  /** @type {EngineResult} */
  let best = { uci: moveToUci(shuffled[0]), score: -Infinity, depth: 0, nodes: 0 };
  for (let depthIter = 1; depthIter <= depth; depthIter++) {
    if (budget.aborted) break;
    let alpha = -Infinity;
    /** @type {InternalMove | null} */
    let iterBest = null;
    let iterScore = -Infinity;
    for (const move of shuffled) {
      if (budget.aborted) break;
      fast._makeMove(move);
      const score = -negamax(chess, depthIter - 1, -Infinity, -alpha, 1, budget, qPlies);
      fast._undoMove();
      if (budget.aborted) break;
      if (score > iterScore) {
        iterScore = score;
        iterBest = move;
      }
      if (score > alpha) alpha = score;
    }
    if (!budget.aborted && iterBest) {
      best = { uci: moveToUci(iterBest), score: iterScore, depth: depthIter, nodes: budget.nodes };
    }
  }
  best.nodes = budget.nodes;
  return best;
}

/**
 * White-perspective quiescence evaluation in centipawns: the truncation
 * adjudicator. Budgeted so a long capture chain cannot spin.
 *
 * @param {Chess} chess
 * @param {EngineParams} [params]
 * @returns {number}
 */
export function quiescenceWhite(chess, params) {
  const qPlies = params?.quiescenceMaxPlies ?? 8;
  const budget = newBudget(params?.nodeBudget ?? 5000);
  const fast = internals(chess);
  const moves = fast._moves({ legal: true });
  const sign = chess.turn() === 'w' ? 1 : -1;
  if (moves.length === 0) {
    // Side to move is mated (its own perspective loses) or stalemated;
    // convert to white's perspective.
    return chess.isCheck() ? -MATE * sign : 0;
  }
  const scored = orderMoves(moves.filter((move) => move.captured || move.promotion));
  let alpha = -Infinity;
  let best = evaluateSideToMove(chess) * sign;
  for (const move of scored) {
    fast._makeMove(move);
    const score = -quiescence(chess, -Infinity, -alpha, qPlies - 1, budget);
    fast._undoMove();
    const whiteScore = score * sign;
    if (whiteScore > best) best = whiteScore;
    if (best > alpha) alpha = best;
    if (budget.aborted) break;
  }
  return best;
}
