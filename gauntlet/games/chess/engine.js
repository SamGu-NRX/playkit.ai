/**
 * The deterministic built-in chess engine: iterative-deepening alpha-beta with
 * a capture-only quiescence step, material + piece-square-table evaluation,
 * MVV-LVA move ordering, a bounded transposition table, and seeded root
 * tie-breaking. Runs on chess.js 1.4.0 internals through one cast helper.
 *
 * Speed: the search generates pseudo-legal moves (`legal: false`) and checks
 * king safety lazily with `_isKingAttacked` only for moves it actually makes,
 * instead of chess.js's eager legality filter that make/unmakes every
 * pseudo-legal move at every node. Quiescence generates pseudo-legal captures
 * directly. Ordering scores sort one index array per node instead of a
 * decorated object array. The transposition table is keyed by FEN and only
 * holds non-mate scores with depth >= 2, so it cannot change a mate line; it
 * is created fresh per `bestMove` call and capped in size.
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
 * @property {(color: string) => boolean} _isKingAttacked
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
 * Find the legal internal move matching a UCI string, or null. Scans the
 * pseudo-legal list for a coordinate match first and king-safety-checks only
 * the candidates that match, instead of fully legal-filtering every move.
 *
 * @param {Chess} chess
 * @param {string} uci
 * @returns {InternalMove | null}
 */
export function matchUci(chess, uci) {
  const fast = internals(chess);
  const mover = fast._turn;
  for (const move of fast._moves({ legal: false })) {
    if (moveToUci(move) !== uci) continue;
    fast._makeMove(move);
    const legal = !fast._isKingAttacked(mover);
    fast._undoMove();
    if (legal) return move;
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
  for (let i = 0; i < uciMoves.length; i++) {
    const move = matchUci(chess, uciMoves[i]);
    if (!move) {
      throw new Error(`illegal move "${uciMoves[i]}" after ${i} plies of ${startFen}`);
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
 * White-perspective static evaluation in centipawns (material + PSTs). The
 * king's game-phase table is chosen from a complete material pre-pass, so a
 * position and its colour mirror always evaluate to exact negations.
 *
 * @param {Chess} chess
 * @returns {number}
 */
export function evaluateWhite(chess) {
  const fast = internals(chess);
  const board = fast._board;
  // Material pre-pass: the king-table choice must see all non-pawn material,
  // not the partially accumulated value at the moment a king is reached.
  let nonPawnMaterial = 0;
  for (let square = 0; square <= 119; square++) {
    if (square & 0x88) {
      square += 7;
      continue;
    }
    const piece = board[square];
    if (!piece || piece.type === 'p' || piece.type === 'k') continue;
    nonPawnMaterial += PIECE_VALUES[piece.type];
  }
  const kingTable = nonPawnMaterial <= ENDGAME_MATERIAL ? KING_END : KING_MIDDLE;
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
    const table = piece.type === 'k' ? kingTable : PSTS[piece.type];
    score += white ? value + table[index] : -(value + table[index]);
  }
  return score;
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/** Mate scores are distance-adjusted: mate in one ply from the root is exactly MATE. */
export const MATE = 999999;

/** Scores at or beyond this magnitude are mate scores, kept out of the TT. */
const MATE_BOUND = MATE - 1000;

/**
 * Search limits. The node budget makes the engine deterministic under the
 * sandbox CPU quota: when the budget runs out mid-iteration, the best move
 * from the last completed depth is kept. `depth` is the iterative-deepening
 * maximum.
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
 * One transposition-table slot.
 *
 * @typedef {object} TtEntry
 * @property {number} depth Remaining depth of the stored score.
 * @property {number} score Stored score, side-to-move perspective.
 * @property {'exact' | 'lower' | 'upper'} flag Bound type.
 */

/**
 * MVV-LVA-ish ordering score: captures by victim value minus attacker value,
 * promotions first. Deterministic.
 *
 * @param {InternalMove} move
 * @param {number[][] | null} [history] Quiet-move cutoff history; null skips it.
 * @returns {number}
 */
function orderScore(move, history) {
  let score = 0;
  if (move.captured) {
    score += 10 * PIECE_VALUES[move.captured] - PIECE_VALUES[move.piece];
  }
  if (move.promotion) {
    score += PIECE_VALUES[move.promotion];
  }
  if (history && !move.captured) {
    // Quiet-move history: how often this from-to pair has caused a beta
    // cutoff. 0x88 squares compact to 0..63.
    score += history[(move.from >> 4) * 8 + (move.from & 7)][(move.to >> 4) * 8 + (move.to & 7)];
  }
  return score;
}

/**
 * Order moves by descending MVV-LVA score, stable on generation order for
 * ties. Sorts one index array instead of decorating every move with an
 * object (the old path allocated two intermediate arrays per node).
 *
 * @param {InternalMove[]} moves
 * @param {number[][] | null} [history] Quiet-move cutoff history; null skips it.
 * @returns {InternalMove[]}
 */
function orderMoves(moves, history) {
  if (moves.length < 2) return moves;
  const keys = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) keys[i] = orderScore(moves[i], history);
  const indices = keys.map((_, i) => i);
  indices.sort((a, b) => keys[b] - keys[a] || a - b);
  return indices.map((i) => moves[i]);
}

/**
 * @param {number} limit
 * @returns {SearchBudget}
 */
function newBudget(limit) {
  return { nodes: 0, limit, aborted: false };
}

/**
 * Is there any legal move? Early-exits on the first one. Only called when
 * the side to move is in check and no capture was available, so the cost is
 * confined to the rare nodes where it changes the score.
 *
 * @param {FastChess} fast
 * @returns {boolean}
 */
function hasLegalMove(fast) {
  const mover = fast._turn;
  const moves = fast._moves({ legal: false });
  for (const move of moves) {
    fast._makeMove(move);
    const legal = !fast._isKingAttacked(mover);
    fast._undoMove();
    if (legal) return true;
  }
  return false;
}

/**
 * Capture-only quiescence with stand-pat. Side-to-move perspective. Moves
 * are generated pseudo-legally and king-safety is checked only for the
 * captures actually made. Mate is detected at nodes in check with no
 * capture to try (the only place it is cheap and changes the score).
 *
 * @param {Chess} chess
 * @param {number} alpha
 * @param {number} beta
 * @param {number} pliesLeft
 * @param {number} ply Ply from the search root (for mate-distance scores).
 * @param {SearchBudget} budget
 * @returns {number}
 */
function quiescence(chess, alpha, beta, pliesLeft, ply, budget) {
  budget.nodes++;
  if (budget.nodes > budget.limit) {
    budget.aborted = true;
    return evaluateSideToMove(chess);
  }
  const fast = internals(chess);
  const inCheck = fast.isCheck();
  const captures = orderMoves(
    fast
      ._moves({ legal: false })
      .filter((move) => move.captured || move.promotion),
    null
  );
  if (inCheck && captures.length === 0 && !hasLegalMove(fast)) {
    return -(MATE - ply + 1);
  }
  const stand = evaluateSideToMove(chess);
  if (pliesLeft <= 0 || stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  let best = stand;
  const mover = fast._turn;
  for (const move of captures) {
    fast._makeMove(move);
    if (fast._isKingAttacked(mover)) {
      fast._undoMove();
      continue;
    }
    const score = -quiescence(chess, -beta, -alpha, pliesLeft - 1, ply + 1, budget);
    fast._undoMove();
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
 * Negamax alpha-beta over pseudo-legal moves with lazy king-safety checks.
 * Terminal checks inside the tree are deliberately cheap: no repetition or
 * insufficient-material probes (the node budget makes them moot; game-level
 * adjudication owns the endings). A bounded transposition table keyed by FEN
 * caches depth >= 2 non-mate scores.
 *
 * @param {Chess} chess
 * @param {number} depth
 * @param {number} alpha
 * @param {number} beta
 * @param {number} ply
 * @param {SearchBudget} budget
 * @param {number} qPlies
 * @param {Map<string, TtEntry> | null} tt Transposition table (null to disable).
 * @param {number[][]} history Quiet-move cutoff history, [from][to] compact indices.
 * @returns {number}
 */
function negamax(chess, depth, alpha, beta, ply, budget, qPlies, tt, history) {
  budget.nodes++;
  if (budget.nodes > budget.limit) {
    budget.aborted = true;
    return evaluateSideToMove(chess);
  }
  const alphaOrig = alpha;
  const fast = internals(chess);
  if (tt && depth >= 2) {
    const entry = tt.get(fast.fen());
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower' && entry.score >= beta) return entry.score;
      if (entry.flag === 'upper' && entry.score <= alpha) return entry.score;
    }
  }
  const moves = fast._moves({ legal: false });
  const mover = fast._turn;
  let best = -Infinity;
  let firstChild = true;
  let legalCount = 0;
  for (const move of orderMoves(moves, history)) {
    if (depth <= 0) {
      // No legality filter was needed to discover there are captures to
      // try; the leaf value comes from quiescence either way.
      best = quiescence(chess, alpha, beta, qPlies, ply, budget);
      break;
    }
    fast._makeMove(move);
    if (fast._isKingAttacked(mover)) {
      fast._undoMove();
      continue;
    }
    // Principal-variation search: the first child gets the full window;
    // the rest get a zero window and re-search only on a cutoff fail-high.
    let score;
    if (firstChild) {
      firstChild = false;
      score = -negamax(chess, depth - 1, -beta, -alpha, ply + 1, budget, qPlies, tt, history);
    } else {
      // Late-move reduction: quiet moves beyond the first few are searched
      // one ply shallower first, and re-searched at full depth only when
      // they beat alpha.
      let reduction = 0;
      if (depth >= 3 && !move.captured && !move.promotion && legalCount > 3) {
        reduction = 1;
        if (depth >= 5 && legalCount > 10) {
          reduction = 2;
        }
      }
      score = -negamax(chess, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, budget, qPlies, tt, history);
      if (!budget.aborted && score > alpha && reduction > 0) {
        score = -negamax(chess, depth - 1, -alpha - 1, -alpha, ply + 1, budget, qPlies, tt, history);
      }
      if (!budget.aborted && score > alpha && score < beta) {
        score = -negamax(chess, depth - 1, -beta, -alpha, ply + 1, budget, qPlies, tt, history);
      }
    }
    fast._undoMove();
    if (budget.aborted) break;
    legalCount++;
    if (score > best) best = score;
    if (best > alpha) {
      alpha = best;
      if (alpha >= beta) {
        // Beta cutoff: credit the quiet move that caused it so ordering
        // prefers it at siblings and later nodes.
        if (!move.captured) {
          const from = (move.from >> 4) * 8 + (move.from & 7);
          const to = (move.to >> 4) * 8 + (move.to & 7);
          history[from][to] += depth * depth;
        }
        break;
      }
    }
  }
  if (best === -Infinity) {
    // No legal move was found (or the budget aborted before one was).
    if (budget.aborted) return evaluateSideToMove(chess);
    return fast.isCheck() ? -(MATE - ply + 1) : 0;
  }
  if (tt && depth >= 2 && !budget.aborted && best > -MATE_BOUND && best < MATE_BOUND) {
    if (tt.size > 200000) tt.clear();
    tt.set(fast.fen(), {
      depth,
      score: best,
      flag: best <= alphaOrig ? 'upper' : best >= beta ? 'lower' : 'exact',
    });
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
  const tt = new Map();
  const history = Array.from({ length: 64 }, () => new Array(64).fill(0));
  /** @type {EngineResult} */
  let best = { uci: moveToUci(shuffled[0]), score: -Infinity, depth: 0, nodes: 0 };
  for (let depthIter = 1; depthIter <= depth; depthIter++) {
    if (budget.aborted) break;
    let alpha = -Infinity;
    /** @type {InternalMove | null} */
    let iterBest = null;
    let iterScore = -Infinity;
    let firstRoot = true;
    let rootLegalCount = 0;
    for (const move of shuffled) {
      if (budget.aborted) break;
      fast._makeMove(move);
      // Root PVS: full window for the first move (the previous iteration's
      // best), zero window plus re-search for the rest.
      let score;
      if (firstRoot) {
        firstRoot = false;
        score = -negamax(chess, depthIter - 1, -Infinity, -alpha, 1, budget, qPlies, tt, history);
      } else {
        // Root LMR mirrors the interior: shallow zero-window probe for late
        // quiet moves, then full-depth and full-window re-search on fail-high.
        let reduction = 0;
        if (depthIter >= 4 && !move.captured && !move.promotion && rootLegalCount > 3) {
          reduction = 1;
        }
        score = -negamax(chess, depthIter - 1 - reduction, -alpha - 1, -alpha, 1, budget, qPlies, tt, history);
        if (!budget.aborted && score > alpha && reduction > 0) {
          score = -negamax(chess, depthIter - 1, -alpha - 1, -alpha, 1, budget, qPlies, tt, history);
        }
        if (!budget.aborted && score > alpha) {
          score = -negamax(chess, depthIter - 1, -Infinity, -alpha, 1, budget, qPlies, tt, history);
        }
      }
      fast._undoMove();
      if (budget.aborted) break;
      rootLegalCount++;
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
 * adjudicator. The root maximum runs in the side-to-move's perspective and
 * converts to white's exactly once at the return, so the referee scores the
 * position for the side that must actually move. Budgeted so a long capture
 * chain cannot spin.
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
  const scored = orderMoves(
    moves.filter((move) => move.captured || move.promotion),
    null
  );
  // Side-to-move perspective throughout; single sign flip at the return.
  let best = evaluateSideToMove(chess);
  let alpha = -Infinity;
  for (const move of scored) {
    fast._makeMove(move);
    const score = -quiescence(chess, -Infinity, -alpha, qPlies - 1, 1, budget);
    fast._undoMove();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (budget.aborted) break;
  }
  return best * sign;
}
