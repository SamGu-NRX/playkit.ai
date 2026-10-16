/**
 * Chess Endgames: conversion tasks scored against a perfect defender. The
 * agent plays White and must convert a won KQK, KRK, KBBK or KBNK position
 * against tablebase-optimal defense; the score is the squared efficiency of
 * the conversion against the tablebase DTM. Pure JS, seeded, deterministic.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { GauntletRuleError } from '../../core/errors.js';
import { nextInt, streamFromSeed } from '../../core/rng.js';
import { probe } from './tablebase.js';

/** @import { Agent, Game, Observation, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */

/**
 * Game state: plain JSON, so it survives a round trip unchanged. The position
 * lives in `fen` (side to move included); the derived fields track progress.
 *
 * @typedef {object} EndgameState
 * @property {('kqk'|'krk'|'kbbk'|'kbnk')} eg Endgame id.
 * @property {string} fen Full FEN of the current position.
 * @property {number} startDtm Tablebase DTM (White moves to mate) of the
 *   starting position under perfect play by both sides.
 * @property {number} whiteMoves White moves completed so far.
 * @property {'playing' | 'mated' | 'stalemate' | 'bare-kings'} status
 */

const ENDGAME_TITLES = {
  kqk: 'K+Q vs K',
  krk: 'K+R vs K',
  kbbk: 'K+B+B vs K',
  kbnk: 'K+B+N vs K',
};

/** Tier definitions: one per endgame, ordered easy to hard. */
const TIER_DEFS = [
  { id: 'kqk', rank: 1, maxActions: 25, band: [4, 10] },
  { id: 'krk', rank: 2, maxActions: 40, band: [6, 16] },
  { id: 'kbbk', rank: 3, maxActions: 48, band: [8, 19] },
  { id: 'kbnk', rank: 4, maxActions: 83, band: [10, 33] },
];

/**
 * @param {'w' | 'b'} color
 * @returns {number}
 */
function colorSeat(color) {
  return color === 'w' ? 0 : 1;
}

/**
 * Current side to move as a seat number.
 *
 * @param {string} fen
 * @returns {number}
 */
function seatToMove(fen) {
  return colorSeat(/** @type {'w' | 'b'} */ (fen.split(' ')[1]));
}

/**
 * Apply a UCI move (from+to; no promotions exist in these endgames) to a FEN,
 * returning the new FEN. The move must be legal.
 *
 * @param {string} fen
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function applyUci(fen, from, to) {
  const chess = new Chess(fen);
  chess.move({ from, to });
  return chess.fen();
}

/**
 * Classify a position for the state machine.
 *
 * @param {Chess} chess
 * @returns {EndgameState['status']}
 */
function classify(chess) {
  if (chess.isCheckmate()) return 'mated';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'bare-kings';
  return 'playing';
}

/**
 * Build a state object from a position.
 *
 * @param {Pick<EndgameState, 'eg' | 'startDtm' | 'whiteMoves'>} base Fields carried over.
 * @param {string} fen
 * @returns {EndgameState}
 */
function makeState(base, fen) {
  const status = classify(new Chess(fen));
  return { ...base, fen, status };
}

/**
 * Squared efficiency of a conversion that took `used` White moves against a
 * starting DTM of `par`: 1.0 for par-perfect conversion, decaying
 * quadratically as the agent takes extra moves.
 *
 * @param {number} par
 * @param {number} used
 * @returns {number}
 */
function efficiency(par, used) {
  if (used <= 0) return 0;
  const ratio = par / used;
  if (ratio >= 1) return 1;
  return ratio * ratio;
}

/**
 * Generate a starting position for a tier by seeded rejection sampling: kings
 * never touching, Black not in check (White cannot be, with this material),
 * and a tablebase DTM inside the tier band. Deterministic per (tier, seed).
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {EndgameState}
 */
function deal(tier, seed) {
  const eg = /** @type {EndgameState['eg']} */ (tier.params.eg);
  const bandMin = /** @type {number} */ (tier.params.bandMin);
  const bandMax = /** @type {number} */ (tier.params.bandMax);
  const stream = streamFromSeed(`${tier.id}/${seed}/deal`);
  let rngState = stream.getState();
  const drawSquare = () => {
    const draw = nextInt(rngState, 0, 63);
    rngState = draw.state;
    return draw.value;
  };
  for (let attempt = 0; attempt < 20000; attempt++) {
    const wk = drawSquare();
    const bk = drawSquare();
    const a1 = drawSquare();
    let a2 = -1;
    if (eg === 'kbbk' || eg === 'kbnk') {
      a2 = drawSquare();
    }
    const squares = [wk, bk, a1, a2];
    if (new Set(squares).size !== squares.length) continue;
    if (
      Math.max(Math.abs((wk >> 3) - (bk >> 3)), Math.abs((wk & 7) - (bk & 7))) <= 1
    ) {
      continue; // kings touching
    }
    const placement = toPlacement(wk, a1, a2, bk, eg);
    const fen = `${placement} w - - 0 1`;
    const chess = new Chess(fen);
    if (chess.isCheck()) continue; // Black (not to move) may not be in check
    const value = probe(eg, fen);
    if (value.draw || value.dtm === null) continue; // not a conversion task
    if (value.dtm < bandMin || value.dtm > bandMax) continue;
    return { eg, fen, startDtm: value.dtm, whiteMoves: 0, status: 'playing' };
  }
  throw new Error(`no ${eg} start position found for tier ${tier.id} seed ${seed}`);
}

/**
 * @param {number} wk
 * @param {number} a1
 * @param {number} a2 -1 when the endgame has one attacker.
 * @param {number} bk
 * @param {('kqk'|'krk'|'kbbk'|'kbnk')} eg
 * @returns {string} FEN piece placement rows.
 */
function toPlacement(wk, a1, a2, bk, eg) {
  const grid = /** @type {(string | null)[]} */ (new Array(64).fill(null));
  grid[wk] = 'K';
  grid[bk] = 'k';
  // Piece types per endgame; the tablebase parser reorders attacker slots to
  // its identity order, so placement order does not matter.
  const pieces = { kqk: ['Q'], krk: ['R'], kbbk: ['B', 'B'], kbnk: ['B', 'N'] }[eg];
  grid[a1] = pieces[0];
  if (a2 >= 0) grid[a2] = pieces[1];
  /** @type {string[]} */
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let run = 0;
    for (let f = 0; f < 8; f++) {
      const piece = grid[r * 8 + f];
      if (piece === null) {
        run += 1;
        continue;
      }
      if (run > 0) {
        row += String(run);
        run = 0;
      }
      row += piece;
    }
    if (run > 0) row += String(run);
    rows.push(row);
  }
  return rows.join('/');
}

/**
 * Legal actions of the seat to move, as sorted UCI from-to strings.
 *
 * @param {string} fen
 * @returns {string[]}
 */
function legalUci(fen) {
  const chess = new Chess(fen);
  return chess
    .moves({ verbose: true })
    .map((m) => `${m.from}${m.to}`)
    .sort();
}

/**
 * Small rank/file board renderer.
 *
 * @param {string} fen
 * @returns {string}
 */
function boardText(fen) {
  const chess = new Chess(fen);
  const chessBoard = chess.board();
  /** @type {string[]} */
  const rows = [];
  rows.push('    a   b   c   d   e   f   g   h');
  for (let r = 7; r >= 0; r--) {
    const cells = chessBoard[r].map((sq) => {
      if (!sq) return '.';
      return sq.color === 'w' ? sq.type.toUpperCase() : sq.type;
    });
    rows.push(` ${r + 1}  ${cells.join('   ')}`);
  }
  return rows.join('\n');
}

/**
 * Zero-sum outcome pair from the agent's score.
 *
 * @param {number} agentScore
 * @param {Array<'win' | 'loss' | 'draw'> | null} raw
 * @param {string} reason
 * @returns {import('../../core/types.js').Outcome}
 */
function pairOutcome(agentScore, raw, reason) {
  const score = Math.min(1, Math.max(0, agentScore));
  const pair = raw === null ? raw : [raw[0], raw[1]];
  return {
    normalized: [score, 1 - score],
    raw: /** @type {Array<'win' | 'loss' | 'draw'> | null} */ (pair),
    reason,
  };
}

/**
 * The terminal outcome of a finished episode, or null while playing.
 *
 * @param {EndgameState} state
 * @returns {import('../../core/types.js').Outcome | null}
 */
function terminalOutcome(state) {
  if (state.status === 'playing') return null;
  if (state.status === 'mated') {
    const score = efficiency(state.startDtm, state.whiteMoves);
    return pairOutcome(
      score,
      ['win', 'loss'],
      `White converted ${ENDGAME_TITLES[state.eg]}: checkmate on move ` +
        `${state.whiteMoves} against perfect defense ` +
        `(optimal was ${state.startDtm}); efficiency score ${score.toFixed(4)}`,
    );
  }
  if (state.status === 'stalemate') {
    return pairOutcome(
      0,
      ['loss', 'win'],
      'conversion failed: White stalemated the defending king',
    );
  }
  return pairOutcome(
    0,
    ['loss', 'win'],
    'conversion failed: the defender captured a piece and the material left is not enough to mate',
  );
}

/**
 * Assess an unfinished position under perfect play from both sides: the
 * agent's would-be score if it converted in the remaining tablebase minimum.
 *
 * @param {EndgameState} state
 * @returns {import('../../core/types.js').Outcome}
 */
function budgetAssessment(state) {
  const value = probe(state.eg, state.fen);
  if (value.draw || value.dtm === null) {
    return pairOutcome(
      0,
      null,
      'truncated: the position no longer assesses as a forced conversion',
    );
  }
  const remaining = value.dtm;
  const score = efficiency(state.startDtm, state.whiteMoves + remaining);
  return pairOutcome(
    score,
    null,
    `truncated: the position still mates in ${remaining} (White moves) under ` +
      `perfect play; would-be efficiency score ${score.toFixed(4)}`,
  );
}

export const chessEndgames = {
  spec: {
    id: 'chess-endgames',
    version: '1.0.0',
    title: 'Chess Endgames',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ ([
      'adversarial',
      'planning',
      'long-horizon',
      'spatial',
    ]),
    benchmark: true,
    requires: [],
    rulesText: [
      'Classical chess king-and-minor endgames: K+Q vs K, K+R vs K, K+B+B vs K and K+B+N vs K.',
      'You play White (seat 0) and must convert a won position to checkmate; Black (seat 1) is a tablebase-perfect defender that captures any undefended piece and takes the longest resistance otherwise.',
      'The score is the squared ratio of the optimal conversion length (the tablebase DTM of the starting position) to the White moves you actually used, so converting exactly on optimal schedule scores 1.0 and every extra move costs; stalemating or letting the defender capture a piece scores 0.',
      'Action grammar: a UCI move <from><to>, e.g. "a1a2" moves the piece on a1 to a2. No promotions or castling exist in these endgames.',
      'Documented alternates: an optional leading verb ("move a1a2"), uppercase squares, and surrounding quotes or backticks are all accepted.',
      'Playing an illegal or unknown move is invalid and consumes an action attempt.',
    ].join(' '),
    tiers: /** @type {import('../../core/types.js').TierSpec[]} */ (
      TIER_DEFS.map((def) => ({
        id: def.id,
        rank: def.rank,
        scoring: /** @type {import('../../core/types.js').ScoringMode} */ ('outcome'),
        maxActions: def.maxActions,
        publicSeeds: 10,
        params: { eg: def.id, bandMin: def.band[0], bandMax: def.band[1] },
      }))
    ),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {EndgameState}
   */
  reset(tier, seed) {
    return deal(tier, seed);
  },

  /**
   * @param {EndgameState} state
   * @returns {number | null}
   */
  toAct(state) {
    if (state.status !== 'playing') return null;
    return seatToMove(state.fen);
  },

  /**
   * @param {EndgameState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const eg = state.eg;
    const tier = /** @type {{ id: string, maxActions: number }} */ (
      TIER_DEFS.find((t) => t.id === eg)
    );
    const you = seat === 0 ? 'White, the converting side' : 'Black, the perfect defender';
    const turn = seatToMove(state.fen);
    const statusText =
      state.status === 'playing'
        ? `${turn === 0 ? 'White' : 'Black'} to move.`
        : state.status === 'mated'
          ? 'Game over: checkmate.'
          : state.status === 'stalemate'
            ? 'Game over: stalemate.'
            : 'Game over: insufficient material.';
    const budget =
      seat === 0 && state.status === 'playing'
        ? `Actions used: ${state.whiteMoves} of at most ${tier.maxActions}.`
        : `White moves so far: ${state.whiteMoves}.`;
    const legal =
      state.status === 'playing' && seat === turn
        ? legalUci(state.fen)
        : [];
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, all listed): ${legal.join(', ')}`
        : 'Legal actions: none.';
    return {
      text: [
        `Chess Endgames, tier ${tier.id} (${ENDGAME_TITLES[eg]}). You are seat ${seat} (${you}).`,
        `Optimal conversion from the start: mate in ${state.startDtm} White moves.`,
        boardText(state.fen),
        `FEN: ${state.fen}`,
        statusText,
        budget,
        legalText,
      ].join('\n'),
      data: {
        eg: state.eg,
        fen: state.fen,
        startDtm: state.startDtm,
        whiteMoves: state.whiteMoves,
        status: state.status,
        you: seat,
        legal,
      },
    };
  },

  /**
   * @param {EndgameState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing') return [];
    if (seat !== seatToMove(state.fen)) return [];
    return legalUci(state.fen);
  },

  /**
   * @param {EndgameState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== seatToMove(state.fen)) {
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
    s = s.toLowerCase();
    s = s.replace(/^(play|place|move)\s+/, '');
    const match = /^([a-h][1-8])\s*[-x>]?\s*([a-h][1-8])$/.exec(s);
    if (!match) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a UCI move; use <from><to>, e.g. "a1a2"`,
      };
    }
    const action = match[1] + match[2];
    if (!legalUci(state.fen).includes(action)) {
      return { ok: false, error: `move ${action} is not legal here` };
    }
    return { ok: true, action };
  },

  /**
   * @param {EndgameState} state
   * @param {number} seat
   * @param {string} action
   * @returns {EndgameState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== seatToMove(state.fen)) {
      throw new GauntletRuleError(`it is seat ${seatToMove(state.fen)}'s turn, not seat ${seat}'s`);
    }
    const legal = legalUci(state.fen);
    if (typeof action !== 'string' || !legal.includes(action)) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const fen = applyUci(state.fen, action.slice(0, 2), action.slice(2, 4));
    const next = makeState(
      { eg: state.eg, startDtm: state.startDtm, whiteMoves: state.whiteMoves },
      fen,
    );
    if (seat === 0) {
      next.whiteMoves = state.whiteMoves + 1;
    }
    return next;
  },

  /**
   * @param {EndgameState} state
   * @returns {import('../../core/types.js').Outcome | null}
   */
  outcome(state) {
    return terminalOutcome(state);
  },

  /**
   * @param {EndgameState} state
   * @returns {import('../../core/types.js').Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return /** @type {import('../../core/types.js').Outcome} */ (terminalOutcome(state));
    }
    return budgetAssessment(state);
  },

  /**
   * The perfect defender: captures any undefended piece (bare kings are a
   * draw), else prefers tablebase-drawn children, else the longest resistance
   * (largest child DTM), with seeded tie-breaks among equals.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    return {
      id: 'tablebase-perfect',
      track: 'baseline',
      async act(ctx) {
        const data = /** @type {EndgameState & { you?: number }} */ (ctx.observation.data);
        const fen = data.fen;
        const eg = data.eg;
        const chess = new Chess(fen);
        /** @type {{ uci: string, rank: number, draw: boolean }[]} */
        const choices = [];
        for (const m of chess.moves({ verbose: true })) {
          const childFen = applyUci(fen, m.from, m.to);
          if (m.captured || new Chess(childFen).isInsufficientMaterial()) {
            choices.push({ uci: `${m.from}${m.to}`, rank: 0, draw: true });
            continue;
          }
          const value = probe(eg, childFen);
          choices.push({
            uci: `${m.from}${m.to}`,
            rank: value.draw ? 0 : /** @type {number} */ (value.dtm) + 1,
            draw: Boolean(value.draw),
          });
        }
        if (choices.length === 0) {
          throw new GauntletRuleError('the perfect defender found no legal move');
        }
        let best = choices[0];
        for (const c of choices) {
          if (c.draw && !best.draw) best = c;
          else if (c.draw === best.draw && c.rank > best.rank) best = c;
        }
        const tied = choices.filter((c) => c.draw === best.draw && c.rank === best.rank);
        const stream = streamFromSeed(`${tier.id}/${seed}/opponent/${seat}/turn${ctx.turn}`);
        const chosen = tied[nextInt(stream.getState(), 0, tied.length - 1).value];
        return { text: chosen.uci };
      },
    };
  },

  /**
   * The agent always converts: seat 0 (White).
   *
   * @param {TierSpec} _tier
   * @param {string} _seed
   * @returns {number}
   */
  agentSeat(_tier, _seed) {
    return 0;
  },
};

/** @type {Game<EndgameState>} */
export default chessEndgames;
