/**
 * Chess for the Gauntlet: the full rules through chess.js 1.4.0, four
 * built-in engine tiers on a seeded opening book, explicit game-level
 * adjudication (the fast make/undo path does not maintain chess.js's
 * repetition table, so threefold is counted here), and truncation scored by
 * a budgeted quiescence evaluation. The agent's seat alternates with the
 * seed across the public seed set.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { GauntletRuleError } from '../../core/errors.js';
import { fnv1a64 } from '../../core/canonical.js';
import { nextInt, streamFromSeed } from '../../core/rng.js';
import {
  internals,
  replayUci,
  legalUcis,
  matchUci,
  quiescenceWhite,
  START_FEN,
} from './engine.js';
import { OPENINGS } from './openings.js';
import { parseAction as parseNotation, parseNotationAsAction } from './notation.js';
import { renderObservation as renderText } from './render.js';
import { createEngineBaselineAgent, createRandomBaselineAgent } from './baselines.js';

/** @import { Agent, Game, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */
/** @import { FastChess } from './engine.js' */

// ---------------------------------------------------------------------------
// Per-state memoization. States are plain JSON and treated as immutable
// (step() must not mutate its input), so the replayed position and the
// repetition-occurrence map for a state can be cached in WeakMaps keyed by
// the state object. Every game-API call that used to replay the full move
// history from scratch now shares one replay per state: without this, a
// conformance playthrough costs O(plies^2) replays (every ply re-parses and
// re-replays the whole history for each legal action).

/** @type {WeakMap<object, Chess>} */
const POSITION_CACHE = new WeakMap();

/** @type {WeakMap<object, Map<string, number>>} */
const OCCURRENCE_CACHE = new WeakMap();

/**
 * The chess.js position for a state, computed once per state and reused.
 * Populated lazily by cachedChess() for read paths (toAct, observe,
 * legalActions, parse) and by step(), which builds a fresh instance at the
 * child position and donates it to the child's cache. Callers may make/undo
 * on it but must leave it restored (the engine and parser contracts already
 * promise this); step() deliberately builds its own fresh instance rather
 * than reusing the parent's, so a caller holding the parent's cached
 * instance can never observe the move being applied.
 *
 * @param {ChessState} state
 * @returns {Chess}
 */
function cachedChess(state) {
  let chessApi = POSITION_CACHE.get(state);
  if (!chessApi) {
    chessApi = stateToChess(state);
    POSITION_CACHE.set(state, chessApi);
  }
  return chessApi;
}

/**
 * The repetition-occurrence map for a state, computed once per state. The
 * child map built in step() inherits the parent map and bumps one key, so a
 * whole episode costs O(plies) occurrence bumps instead of O(plies^2) full
 * history replays.
 *
 * @param {ChessState} state
 * @returns {Map<string, number>}
 */
function cachedOccurrences(state) {
  let counts = OCCURRENCE_CACHE.get(state);
  if (!counts) {
    counts = positionOccurrences(state.startFen, state.moves);
    OCCURRENCE_CACHE.set(state, counts);
  }
  return counts;
}

/** Perft positions from chessprogramming.org/Perft_Results. */
export const PERFT_FENS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  kiwipete: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  position3: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
};

/** Truncation threshold in centipawns: at least a full rook of quiescence advantage wins. */
export const TRUNCATION_WIN_CP = 500;

const MAX_ACTIONS = 150;

/**
 * @typedef {object} Termination
 * @property {'checkmate' | 'stalemate' | 'threefold' | 'fifty' | 'material' | 'truncation'} type
 * @property {'w' | 'b' | null} winner
 */

/**
 * Game state: plain JSON. `moves` is the canonical UCI list; `san` mirrors it
 * for display; `fen` is the position after the last move.
 *
 * @typedef {object} ChessState
 * @property {string} startFen
 * @property {string[]} moves
 * @property {string[]} san
 * @property {string} fen
 * @property {number} openingPlies
 * @property {string | null} openingName
 * @property {Termination | null} termination
 */

/**
 * Chess.js position from a state, replayed on the fast path.
 *
 * @param {ChessState} state
 * @returns {Chess}
 */
export function stateToChess(state) {
  return replayUci(state.startFen, state.moves);
}

/**
 * Seat number of the side to move.
 *
 * @param {Chess} chess
 * @returns {number}
 */
function seatOfTurn(chess) {
  return chess.turn() === 'w' ? 0 : 1;
}

/**
 * Count position occurrences along the game so far, including the start
 * position. Deliberately walks the history itself: chess.js's fast
 * _makeMove/_undoMove path does not maintain the repetition table behind
 * isThreefoldRepetition(), so this environment-side count is the only correct
 * source for threefold adjudication.
 *
 * @param {string} startFen
 * @param {readonly string[]} moves UCI list.
 * @returns {Map<string, number>}
 */
export function positionOccurrences(startFen, moves) {
  const chess = new Chess(startFen);
  const fast = /** @type {FastChess} */ (/** @type {unknown} */ (chess));
  /** @type {Map<string, number>} */
  const counts = new Map();
  const bump = () => {
    // A position for repetition purposes is the 4-field FEN prefix (piece
    // placement, side to move, castling, en passant).
    const key = chess.fen().split(' ').slice(0, 4).join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  bump();
  for (const uci of moves) {
    const move = matchUci(chess, uci);
    if (!move) {
      throw new Error(`positionOccurrences: illegal move "${uci}" in history`);
    }
    fast._makeMove(move);
    bump();
  }
  return counts;
}

/**
 * Game-level termination of the position after `moves` from `startFen`.
 * Truncation is not a position property, so it is never returned here; the
 * 150-action budget is adjudicated by truncate(). Insufficient material is
 * checked last, and the knight-shuffle threefold test relies on a knight per
 * side so material cannot fire first.
 *
 * @param {Chess} chess Position after the moves.
 * @param {string} startFen
 * @param {readonly string[]} moves
 * @param {Map<string, number>} [occurrences] Precomputed repetition map (the
 *   incremental path in step()); computed from the history when omitted.
 * @returns {Termination | null}
 */
export function terminationOf(chess, startFen, moves, occurrences) {
  const fast = /** @type {FastChess} */ (/** @type {unknown} */ (chess));
  if (fast._moves({ legal: true }).length === 0) {
    if (chess.isCheck()) {
      const winner = chess.turn() === 'w' ? 'b' : 'w';
      return { type: 'checkmate', winner };
    }
    return { type: 'stalemate', winner: null };
  }
  const key = chess.fen().split(' ').slice(0, 4).join(' ');
  // occurrences is the precomputed repetition map when the caller has one
  // (the incremental path in step()); otherwise it is computed here.
  const counts = occurrences ?? positionOccurrences(startFen, moves);
  if ((counts.get(key) ?? 0) >= 3) {
    return { type: 'threefold', winner: null };
  }
  if (fast._halfMoves >= 100) {
    return { type: 'fifty', winner: null };
  }
  if (chess.isInsufficientMaterial()) {
    return { type: 'material', winner: null };
  }
  return null;
}

/**
 * Quiescence-based truncation adjudication from white's perspective.
 *
 * @param {Chess} chess
 * @returns {Outcome}
 */
function adjudicateTruncation(chess) {
  const score = quiescenceWhite(chess, { nodeBudget: 20000, quiescenceMaxPlies: 10 });
  if (score >= TRUNCATION_WIN_CP) {
    return {
      normalized: [1, 0],
      raw: null,
      reason: `truncated at the action budget: white leads by ${score}cp in quiescence`,
    };
  }
  if (score <= -TRUNCATION_WIN_CP) {
    return {
      normalized: [0, 1],
      raw: null,
      reason: `truncated at the action budget: black leads by ${-score}cp in quiescence`,
    };
  }
  return {
    normalized: [0.5, 0.5],
    raw: null,
    reason: `truncated at the action budget: quiescence score ${score}cp is inside the draw band`,
  };
}

/** @type {Outcome['normalized'][number][]} */
const DRAW_NORMALIZED = [0.5, 0.5];

/**
 * Map a termination to the contract outcome.
 *
 * @param {Termination} termination
 * @returns {Outcome}
 */
function outcomeOfTermination(termination) {
  if (termination.type === 'checkmate') {
    return termination.winner === 'w'
      ? {
          normalized: [1, 0],
          raw: /** @type {Outcome['raw']} */ (['win', 'loss']),
          reason: 'white wins by checkmate',
        }
      : {
          normalized: [0, 1],
          raw: /** @type {Outcome['raw']} */ (['loss', 'win']),
          reason: 'black wins by checkmate',
        };
  }
  const drawReasons = {
    stalemate: 'draw by stalemate',
    threefold: 'draw by threefold repetition',
    fifty: 'draw by fifty-move rule',
    material: 'draw by insufficient material',
  };
  return {
    normalized: DRAW_NORMALIZED,
    raw: /** @type {Outcome['raw']} */ (['draw', 'draw']),
    reason: drawReasons[/** @type {'stalemate' | 'threefold' | 'fifty' | 'material'} */ (termination.type)],
  };
}

export const chess = {
  spec: {
    id: 'chess',
    version: '1.2.0',
    title: 'Chess',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Standard chess on an 8x8 board, files a-h and ranks 1-8; seat 0 plays white (uppercase) and moves first, seat 1 plays black.',
      'Episodes begin from a named opening-book line (full mainlines such as the Ruy Lopez or Najdorf Sicilian) rather than the bare start position.',
      'Action grammar: UCI coordinates, e.g. "e2e4" or "e7e8q" for promotion; Standard Algebraic Notation like "Nf3", "exd5", "O-O" is also accepted, with or without check/mate marks.',
      'Games end by checkmate, stalemate, threefold repetition, the fifty-move rule, or insufficient material; a game that reaches the 150-action budget is adjudicated from a quiescence search (a lead of about a rook wins, anything closer is a draw).',
      'Playing an unknown or illegal move is invalid and consumes an action attempt.',
    ].join(' '),
    tiers: /** @type {import('../../core/types.js').TierSpec[]} */ ([
      {
        // Sand: the opponent plays a uniformly random legal move (seeded),
        // so the only skill under test is finishing legal chess games at all.
        // It sits below paper on the ladder: paper's shallow engine already
        // punishes loose play, while a random opponent gives wins away, so a
        // model that cannot convert should lose here before it loses on paper.
        id: 'sand',
        rank: 1,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: {},
      },
      {
        id: 'paper',
        rank: 2,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { depth: 2, nodeBudget: 6000, quiescenceMaxPlies: 6 },
      },
      {
        id: 'wood',
        rank: 3,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { depth: 3, nodeBudget: 24000, quiescenceMaxPlies: 8 },
      },
      {
        id: 'steel',
        rank: 4,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { depth: 4, nodeBudget: 70000, quiescenceMaxPlies: 8 },
      },
      {
        id: 'granite',
        rank: 5,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { depth: 5, nodeBudget: 160000, quiescenceMaxPlies: 10 },
      },
    ]),
  },

  /**
   * Deterministic reset: pick the opening book line by seed, play it out,
   * and store the resulting position and history.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {ChessState}
   */
  reset(tier, seed) {
    const stream = streamFromSeed(`${tier.id}/${seed}/opening`);
    const index = nextInt(stream.getState(), 0, OPENINGS.length - 1).value;
    const opening = OPENINGS[index];
    const chessApi = new Chess();
    /** @type {string[]} */
    const moves = [];
    /** @type {string[]} */
    const sans = [];
    for (const san of opening.san) {
      const move = chessApi.move(san);
      moves.push(`${move.from}${move.to}${move.promotion ?? ''}`);
      sans.push(move.san);
    }
    return {
      startFen: START_FEN,
      moves,
      san: sans,
      fen: chessApi.fen(),
      openingPlies: opening.san.length,
      openingName: opening.name,
      termination: terminationOf(chessApi, START_FEN, moves),
    };
  },

  /**
   * Seat to act, or null when the game is over.
   *
   * @param {ChessState} state
   * @returns {number | null}
   */
  toAct(state) {
    if (state.termination) return null;
    return seatOfTurn(cachedChess(state));
  },

  /**
   * Full observation: board, side to move, history, opening, legal actions.
   * Chess is perfect information, so the whole position is shown.
   *
   * @param {ChessState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const chessApi = cachedChess(state);
    const legal = this.legalActions(state, seat);
    return {
      text: renderText(chessApi, state, seat, legal),
      data: { ...state, you: seat },
    };
  },

  /**
   * Sorted legal UCI actions for the mover; empty for the waiting seat or a
   * finished game.
   *
   * @param {ChessState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.termination) return [];
    if (seat !== seatOfTurn(cachedChess(state))) return [];
    return legalUcis(cachedChess(state));
  },

  /**
   * Parse UCI or SAN against the current position; canonical output is UCI.
   *
   * @param {ChessState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.termination) {
      return { ok: false, error: 'the game is over' };
    }
    const chessApi = cachedChess(state);
    if (seat !== seatOfTurn(chessApi)) {
      return { ok: false, error: `it is not seat ${seat}'s turn` };
    }
    return parseNotationAsAction(chessApi, text);
  },

  /**
   * Apply a UCI action on the fast path. Throws GauntletRuleError on a
   * finished game, the wrong seat, or an unknown/illegal action.
   *
   * @param {ChessState} state
   * @param {number} seat
   * @param {string} action
   * @returns {ChessState}
   */
  step(state, seat, action) {
    if (state.termination) {
      throw new GauntletRuleError('the game is over');
    }
    const chessApi = stateToChess(state);
    const toAct = seatOfTurn(chessApi);
    if (seat !== toAct) {
      throw new GauntletRuleError(`it is seat ${toAct}'s turn, not seat ${seat}'s`);
    }
    if (typeof action !== 'string') {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const internal = matchUci(chessApi, action);
    if (!internal) {
      throw new GauntletRuleError(
        `illegal or unknown action ${JSON.stringify(action)} for seat ${seat}`
      );
    }
    const fast = internals(chessApi);
    const sanText = fast._moveToSan(internal, fast._moves({ legal: true }));
    fast._makeMove(internal);
    const moves = [...state.moves, action];
    // Inherit the parent's repetition map and bump the child position, so
    // occurrence counting is incremental across an episode.
    const childKey = chessApi.fen().split(' ').slice(0, 4).join(' ');
    const childOccurrences = new Map(cachedOccurrences(state));
    childOccurrences.set(childKey, (childOccurrences.get(childKey) ?? 0) + 1);
    const child = {
      startFen: state.startFen,
      moves,
      san: [...state.san, sanText],
      fen: chessApi.fen(),
      openingPlies: state.openingPlies,
      openingName: state.openingName,
      termination: terminationOf(chessApi, state.startFen, moves, childOccurrences),
    };
    OCCURRENCE_CACHE.set(child, childOccurrences);
    // The fresh instance now sits exactly at the child position and nothing
    // else holds it, so handing it to the child's cache is safe by
    // construction: the next read of the child reuses this replay instead of
    // replaying the whole history again.
    POSITION_CACHE.set(child, chessApi);
    return child;
  },

  /**
   * Outcome of a terminated state, or null while the game runs.
   *
   * @param {ChessState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    const termination = state.termination;
    if (!termination) return null;
    if (termination.type === 'truncation') {
      return adjudicateTruncation(cachedChess(state));
    }
    return outcomeOfTermination(termination);
  },

  /**
   * Truncation at the 150-action budget: adjudicate by quiescence
   * evaluation. A lead of >= 500cp (about a rook) wins for the leading
   * side; anything closer is a draw.
   *
   * @param {ChessState} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.termination && state.termination.type !== 'truncation') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    return adjudicateTruncation(cachedChess(state));
  },

  /**
   * The tier opponent: for sand, a seeded uniform random legal mover; for
   * the engine tiers, the built-in engine reading the tier's depth and node
   * budget, with seeded tie-breaking.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    const factory =
      tier.id === 'sand' ? createRandomBaselineAgent : createEngineBaselineAgent;
    return factory({
      tier,
      seed,
      seat,
      id: `chess-${tier.id}-opponent`,
    });
  },

  /**
   * The agent's seat alternates with the seed, so it plays both colours
   * across the public seed set.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {number}
   */
  agentSeat(tier, seed) {
    return Number(BigInt('0x' + fnv1a64(`${tier.id}/${seed}`)) % 2n);
  },
};

/**
 * Build a state from a FEN with an empty history (test helper for crafted
 * positions).
 *
 * @param {string} fen
 * @returns {ChessState}
 */
export function stateFromFen(fen) {
  const chessApi = new Chess(fen);
  return {
    startFen: fen,
    moves: [],
    san: [],
    fen,
    openingPlies: 0,
    openingName: null,
    termination: terminationOf(chessApi, fen, []),
  };
}

/** @type {Game<ChessState>} */
export default chess;
