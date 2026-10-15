/**
 * Chess Endgames: the agent is White with winning material and must checkmate
 * a Black king that defends with maximum resistance. Episodes are scored by
 * efficiency against the exact optimum: the distance-to-mate (DTM) of the
 * start position, read from the self-built tablebase in `tablebase.js`.
 *
 * State is plain JSON (FEN plus history counts), so it survives a round trip
 * and chess.js is reconstructed from the FEN at every transition. The
 * observation never reveals the DTM or the par value.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { GauntletRuleError } from '../../core/errors.js';
import { streamFromSeed } from '../../core/rng.js';
import {
  getTablebase,
  positionFromPlacement,
} from './tablebase.js';

/** @import { Agent, Game, Observation, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */

/**
 * @typedef {object} ChessEndgameResult
 * @property {boolean} solved True when the agent delivered checkmate.
 * @property {string} reason Why the game ended.
 */

/**
 * @typedef {object} ChessEndgameState
 * @property {string} kind One of 'kqk' | 'krk' | 'kbbk' | 'kbnk'.
 * @property {string} tierId Tier id, echoed in observations.
 * @property {number} maxActions The tier's action budget, for display.
 * @property {string} fen Current position, clocks maintained by chess.js.
 * @property {number} par The start position's DTM (agent moves to mate).
 * @property {Record<string, number>} history Occurrence counts of
 *   `<placement> <side>` keys, for threefold repetition.
 * @property {0 | 1} side Side to move: 0 White (agent), 1 Black (defender).
 * @property {'playing' | 'over'} status
 * @property {ChessEndgameResult | null} result Set exactly when status is over.
 * @property {number} agentMoves White moves played so far.
 * @property {number} ply Half-moves played so far.
 */

/** Piece letter per type, for building FEN placements. */
const PIECE_UPPER = { q: 'Q', r: 'R', b: 'B', n: 'N' };

/**
 * The tier table: bands rise in floor and ceiling and every band maximum is
 * the published DTM maximum of its ending (10/16/19/33, White to move).
 *
 * @param {string} kindId
 * @returns {{ kind: string, bandMin: number, bandMax: number }}
 */
function tierParams(kindId) {
  /** @type {Record<string, { kind: string, bandMin: number, bandMax: number }>} */
  const bands = {
    kqk: { kind: 'kqk', bandMin: 6, bandMax: 10 },
    krk: { kind: 'krk', bandMin: 10, bandMax: 16 },
    kbbk: { kind: 'kbbk', bandMin: 12, bandMax: 19 },
    kbnk: { kind: 'kbnk', bandMin: 20, bandMax: 33 },
  };
  const params = bands[kindId];
  if (!params) throw new Error(`unknown tier kind ${JSON.stringify(kindId)}`);
  return params;
}

/**
 * The piece types of a kind, in slot order (slot 0 is the table's first
 * piece). For kbnk slot 0 is the bishop, matching tablebase.js.
 *
 * @param {string} kindId
 * @returns {('q' | 'r' | 'b' | 'n')[]}
 */
function pieceTypes(kindId) {
  switch (kindId) {
    case 'kqk':
      return ['q'];
    case 'krk':
      return ['r'];
    case 'kbbk':
      return ['b', 'b'];
    case 'kbnk':
      return ['b', 'n'];
    default:
      throw new Error(`unknown kind ${JSON.stringify(kindId)}`);
  }
}

/**
 * FEN piece-placement field from squares.
 *
 * @param {string} kindId
 * @param {number} wk
 * @param {number} bk
 * @param {number[]} pieces Piece squares in slot order.
 * @returns {string}
 */
function placementFromSquares(kindId, wk, bk, pieces) {
  const types = pieceTypes(kindId);
  /** @type {(string | null)[]} */
  const grid = new Array(64).fill(null);
  grid[wk] = 'K';
  grid[bk] = 'k';
  pieces.forEach((sq, i) => {
    grid[sq] = PIECE_UPPER[types[i]];
  });
  /** @type {string[]} */
  const ranks = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const cell = grid[r * 8 + f];
      if (cell === null) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += cell;
    }
    if (empty > 0) row += String(empty);
    ranks.push(row);
  }
  return ranks.join('/');
}

/**
 * @param {string} fen
 * @returns {string} The `<placement> <side>` repetition key.
 */
function repetitionKey(fen) {
  const fields = fen.split(' ');
  return `${fields[0]} ${fields[1]}`;
}

/**
 * @param {string} fen
 * @returns {number} The half-move clock (fifty-move rule counter).
 */
function halfmoveClock(fen) {
  return Number(fen.split(' ')[4]);
}

/**
 * Sample the tier's start position: legal, White to move, DTM inside the
 * band. Deterministic in (tier, seed) through the core RNG stream.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {{ wk: number, bk: number, pieces: number[], dtm: number }}
 */
function sampleStart(tier, seed) {
  const params = tierParams(String(tier.id));
  const table = getTablebase(params.kind);
  const types = pieceTypes(params.kind);
  const rng = streamFromSeed(`${tier.id}/${seed}/start`);
  const maxAttempts = 1000000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wk = rng.nextInt(0, 63);
    const bk = rng.nextInt(0, 63);
    if (bk === wk) continue;
    /** @type {number[]} */
    const pieces = [];
    for (let i = 0; i < types.length; i++) {
      let sq = rng.nextInt(0, 63);
      while (sq === wk || sq === bk || pieces.includes(sq)) {
        sq = rng.nextInt(0, 63);
      }
      pieces.push(sq);
    }
    const pos = { wk, bk, pieces, side: /** @type {0} */ (0) };
    const dtm = table.dtm(pos);
    if (dtm === null || dtm < params.bandMin || dtm > params.bandMax) continue;
    return { wk, bk, pieces, dtm };
  }
  throw new Error(
    `could not sample a ${tier.id} start position in DTM band [${params.bandMin}, ${params.bandMax}]`
  );
}

/**
 * The efficiency score of a solved episode: the agent played at most `par`
 * moves (par is the proven minimum), so the ratio is at most 1.
 *
 * @param {number} par
 * @param {number} agentMoves
 * @returns {number}
 */
function efficiencyScore(par, agentMoves) {
  if (agentMoves <= 0) return 0;
  return Math.min(1, (par / agentMoves) * (par / agentMoves));
}

export const chessEndgames = {
  spec: {
    id: 'chess-endgames',
    version: '1.0.0',
    title: 'Chess Endgames',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning', 'long-horizon']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Chess endgames: you are White (seat 0) with winning material — a queen, a rook, two bishops on opposite colours, or bishop and knight — against a lone Black king (seat 1) that defends with maximum resistance.',
      'You must deliver checkmate within the action budget. Chess rules apply exactly as in standard chess, except there are no pawns, no castling, and no en passant.',
      'Action grammar: a move as UCI from-to squares, e.g. "d1d2" moves the piece on d1 to d2. Documented alternates: SAN such as "Qd8+", "Kd2" or "Qh8#", an optional leading verb ("move d1d2", "play Qd8"), wrapping quotes or backticks, and any capitalisation.',
      'The game ends in your favour only by checkmate; every win is scored by efficiency against par, the proven minimum number of White moves needed from the start position (distance-to-mate): score = (par / your move count) squared, capped at 1.',
      'The game ends unsolved (score 0) on stalemate, insufficient material, threefold repetition, the fifty-move rule (100 half-moves without a capture or pawn move), or exhausting the action budget.',
      'Invalid or unparseable actions consume action attempts.',
    ].join(' '),
    tiers: /** @type {import('../../core/types.js').TierSpec[]} */ ([
      {
        id: 'kqk',
        rank: 1,
        scoring: 'efficiency',
        maxActions: 50,
        publicSeeds: 25,
        params: { ...tierParams('kqk') },
        parKind: 'optimal',
      },
      {
        id: 'krk',
        rank: 2,
        scoring: 'efficiency',
        maxActions: 80,
        publicSeeds: 25,
        params: { ...tierParams('krk') },
        parKind: 'optimal',
      },
      {
        id: 'kbbk',
        rank: 3,
        scoring: 'efficiency',
        maxActions: 95,
        publicSeeds: 25,
        params: { ...tierParams('kbbk') },
        parKind: 'optimal',
      },
      {
        id: 'kbnk',
        rank: 4,
        scoring: 'efficiency',
        maxActions: 165,
        publicSeeds: 25,
        params: { ...tierParams('kbnk') },
        parKind: 'optimal',
      },
    ]),
  },

  /**
   * Deterministic in (tier, seed): sample a legal start position whose DTM
   * lies inside the tier's band, White to move.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {ChessEndgameState}
   */
  reset(tier, seed) {
    const kind = String(tier.id);
    const params = tierParams(kind);
    const start = sampleStart(tier, seed);
    const placement = placementFromSquares(kind, start.wk, start.bk, start.pieces);
    const fen = `${placement} w - - 0 1`;
    const key = `${placement} w`;
    return {
      kind,
      tierId: tier.id,
      maxActions: tier.maxActions,
      fen,
      par: start.dtm,
      history: { [key]: 1 },
      side: /** @type {0 | 1} */ (0),
      status: 'playing',
      result: null,
      agentMoves: 0,
      ply: 0,
    };
  },

  /**
   * @param {ChessEndgameState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? state.side : null;
  },

  /**
   * @param {ChessEndgameState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const chess = new Chess(state.fen);
    /** @type {string[]} */
    const rows = ['    a   b   c   d   e   f   g   h'];
    const board = chess.board();
    for (let r = 0; r < 8; r++) {
      const rank = 8 - r;
      const cells = board[r].map((cell) => (cell === null ? '.' : cell.color === 'w' ? cell.type.toUpperCase() : cell.type));
      rows.push(` ${rank}  ${cells.join('   ')}`);
    }
    const legal = chessEndgames.legalActions(state, seat);
    const role =
      seat === 0
        ? 'White — deliver checkmate efficiently'
        : 'Black — hold the draw with maximum resistance';
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : 'Legal actions: none (game over).';
    const statusText =
      state.status === 'playing'
        ? `${state.side === 0 ? 'White' : 'Black'} to move.`
        : `Game over: ${state.result === null ? 'unknown' : state.result.reason}.`;
    return {
      text: [
        `Chess endgames, tier ${state.tierId} (${state.kind}: ${materialText(state.kind)}). You are seat ${seat}: ${role}.`,
        rows.join('\n'),
        `FEN: ${state.fen}`,
        statusText,
        `White valid moves made: ${state.agentMoves} of the ${state.maxActions} action budget.`,
        `Half-move clock: ${halfmoveClock(state.fen)} (the fifty-move rule draws the game at 100).`,
        legalText,
      ].join('\n'),
      data: { ...state, seat },
    };
  },

  /**
   * Sorted UCI actions of the side to move.
   *
   * @param {ChessEndgameState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== state.side) return [];
    const chess = new Chess(state.fen);
    return chess
      .moves({ verbose: true })
      .map((m) => m.from + m.to)
      .sort();
  },

  /**
   * Accepts canonical UCI ("d1d2"), SAN alternates ("Qd8+", "Kd2"), optional
   * verb prefixes, quotes and any capitalisation.
   *
   * @param {ChessEndgameState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== state.side) {
      return { ok: false, error: `it is not seat ${seat}'s turn` };
    }
    let s = String(text).trim();
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/^(move|play|make)\s+/i, '');
    const legal = chessEndgames.legalActions(state, seat);
    const uciMatch = /^([a-h][1-8])([a-h][1-8])$/.exec(s.toLowerCase());
    if (uciMatch) {
      const uci = uciMatch[1] + uciMatch[2];
      if (legal.includes(uci)) return { ok: true, action: uci };
      return { ok: false, error: `illegal move ${JSON.stringify(uci)} in this position` };
    }
    // SAN alternate, resolved by chess.js.
    try {
      const chess = new Chess(state.fen);
      const move = chess.move(s);
      const uci = move.from + move.to;
      if (legal.includes(uci)) return { ok: true, action: uci };
      return { ok: false, error: `illegal move ${JSON.stringify(s)} in this position` };
    } catch {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a move; use UCI like "d1d2" or SAN like "Qd8+"`,
      };
    }
  },

  /**
   * @param {ChessEndgameState} state
   * @param {number} seat
   * @param {string} action
   * @returns {ChessEndgameState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== state.side) {
      throw new GauntletRuleError(`it is seat ${state.side}'s turn, not seat ${seat}'s`);
    }
    const legal = chessEndgames.legalActions(state, seat);
    if (!legal.includes(action)) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const chess = new Chess(state.fen);
    chess.move({ from: action.slice(0, 2), to: action.slice(2, 4) });
    const fen = chess.fen();
    const key = repetitionKey(fen);
    const history = { ...state.history };
    history[key] = (history[key] ?? 0) + 1;

    let status = /** @type {ChessEndgameState['status']} */ ('playing');
    /** @type {ChessEndgameResult | null} */
    let result = null;
    if (chess.isCheckmate()) {
      status = 'over';
      result = { solved: true, reason: 'checkmate' };
    } else if (chess.isStalemate()) {
      status = 'over';
      result = { solved: false, reason: 'stalemate' };
    } else if (chess.isInsufficientMaterial()) {
      status = 'over';
      result = { solved: false, reason: 'insufficient material' };
    } else if (history[key] >= 3) {
      status = 'over';
      result = { solved: false, reason: 'threefold repetition' };
    } else if (halfmoveClock(fen) >= 100) {
      status = 'over';
      result = { solved: false, reason: 'fifty-move rule' };
    }

    return {
      ...state,
      fen,
      history,
      side: seat === 0 ? 1 : 0,
      status,
      result,
      agentMoves: seat === 0 ? state.agentMoves + 1 : state.agentMoves,
      ply: state.ply + 1,
    };
  },

  /**
   * Efficiency outcome. Solved: (par / agentMoves) squared for White, 0 for
   * Black. Unsolved (the defender held): 0 for White, 1 for Black.
   *
   * @param {ChessEndgameState} state
   * @returns {import('../../core/types.js').Outcome | null}
   */
  outcome(state) {
    if (state.status !== 'over' || state.result === null) return null;
    const { solved } = state.result;
    const score = solved ? efficiencyScore(state.par, state.agentMoves) : 0;
    const normalized = solved ? [score, 0] : [0, 1];
    const efficiency = solved
      ? `; efficiency ${score.toFixed(4)} (par ${state.par}, ${state.agentMoves} White moves)`
      : '';
    return {
      normalized,
      raw: null,
      reason: `${state.result.reason}${efficiency}`,
      solved,
      par: state.par,
    };
  },

  /**
   * Required by the Game contract; the runner never calls it on efficiency
   * tiers (budget exhaustion scores as unsolved there). A truncated finished
   * state keeps its outcome; an unfinished state assesses as unsolved with
   * the defender holding.
   *
   * @param {ChessEndgameState} state
   * @returns {import('../../core/types.js').Outcome}
   */
  truncate(state) {
    if (state.status === 'over') {
      return /** @type {import('../../core/types.js').Outcome} */ (chessEndgames.outcome(state));
    }
    return {
      normalized: [0, 1],
      raw: null,
      reason: 'truncated: the action budget ran out with the game unfinished',
      solved: false,
      par: state.par,
    };
  },

  /**
   * The defender: maximum resistance. It prefers a move into a drawn
   * position (including any capture, which leaves insufficient material);
   * otherwise the move after which White's mate is furthest away. Ties are
   * broken by the seeded per-turn RNG stream.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    return {
      id: 'tablebase-defender',
      track: 'baseline',
      /**
       * @param {TurnContext} ctx
       * @returns {Promise<{ text: string }>}
       */
      async act(ctx) {
        const data = /** @type {ChessEndgameState & { seat?: number }} */ (ctx.observation.data);
        const table = getTablebase(data.kind);
        const chess = new Chess(data.fen);
        const verbose = chess.moves({ verbose: true });
        if (verbose.length === 0) {
          throw new GauntletRuleError('tablebase defender found no legal move');
        }
        /** @type {import('chess.js').Move[]} */
        const drawn = [];
        /** @type {{ m: import('chess.js').Move, d: number }[]} */
        const fight = [];
        for (const m of verbose) {
          if (m.captured) {
            // The capture leaves K vs K (or K+minor vs K): a draw by
            // insufficient material — the best outcome for Black.
            drawn.push(m);
            continue;
          }
          chess.move({ from: m.from, to: m.to });
          const placement = chess.fen().split(' ')[0];
          const pos = positionFromPlacement(data.kind, placement, 0);
          const d = table.dtm(pos);
          chess.undo();
          if (d === null) drawn.push(m);
          else fight.push({ m, d });
        }
        const stream = streamFromSeed(`${tier.id}/${seed}/opponent/${seat}/turn${ctx.turn}`);
        if (drawn.length > 0) {
          const pick = stream.nextInt(0, drawn.length - 1);
          return { text: drawn[pick].from + drawn[pick].to };
        }
        let best = -1;
        for (const f of fight) best = Math.max(best, f.d);
        const tied = fight.filter((f) => f.d === best);
        const pick = stream.nextInt(0, tied.length - 1);
        return { text: tied[pick].m.from + tied[pick].m.to };
      },
    };
  },
};

/**
 * Human text for the material of a kind.
 *
 * @param {string} kindId
 * @returns {string}
 */
function materialText(kindId) {
  switch (kindId) {
    case 'kqk':
      return 'K+Q vs K';
    case 'krk':
      return 'K+R vs K';
    case 'kbbk':
      return 'K+B+B vs K';
    case 'kbnk':
      return 'K+B+N vs K';
    default:
      return kindId;
  }
}

/** @type {Game<ChessEndgameState>} */
export default chessEndgames;
