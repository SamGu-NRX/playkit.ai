/**
 * Sliding-tile puzzle (the 8- and 15-puzzle) for PlayKit Gauntlet. One seat,
 * perfect information, deterministic: every instance and its proven-optimal
 * par are pure functions of (tier, seed).
 *
 * Scoring is action efficiency against the optimal solution length (the
 * ARC-AGI-3 style): an episode's efficiency score is
 * `solved ? (par / agentActions)^2 : 0`, capped at 1.0 because parKind is
 * "optimal" — you cannot beat the optimal line. The runner counts invalid
 * attempts in agentActions; this game's outcome() can only see its own valid
 * move count, so outcome.normalized reports the score over valid moves and
 * the scoring layer recomputes from the trajectory's agentActions count.
 *
 * Direction convention (matches draft PR #9's fifteen-puzzle adapter, so a
 * later bridge to the live 15-puzzle site maps action-for-action): an action
 * names the direction the TILE slides. "up" slides the tile below the blank
 * upward (the blank moves down); "right" slides the tile to the LEFT of the
 * blank rightward. Stated in rulesText and pinned by tests.
 *
 * Tiers are efficiency-scored with parKind "optimal":
 * - p8:        3 x 3, uniformly random solvable (par 1..31).
 * - p15-short: 4 x 4, optimal length 20-29.
 * - p15-mid:   4 x 4, optimal length 30-39.
 * - p15-long:  4 x 4, optimal length 40-49.
 * maxActions follows ARC-AGI-3's 5x budget rule: 5 x the largest possible par
 * in the tier (the runner takes one static budget per tier, so the per-seed
 * rule max(20, 5 x par) is implemented as the 5x worst case: p8 155,
 * p15-short 145, p15-mid 195, p15-long 245).
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { publicSeed } from '../../core/seeds.js';
import {
  applyTileMove,
  isSolved,
  legalMoves,
  solve,
  DIRECTIONS,
} from './solver.js';
import { generateBanded, generateUniformSolvable } from './instances.js';

/** @import { Game, InformationMode, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */
/** @import { Direction } from './solver.js' */

/**
 * Game state: plain JSON, so it survives a round trip unchanged.
 *
 * @typedef {object} SlidingState
 * @property {number} size Board width (3 or 4).
 * @property {number[][]} board Nested board, blank = 0.
 * @property {number} par Proven-optimal move count, computed at reset.
 * @property {number} maxActions The tier's static action budget.
 * @property {number} moveCount Valid moves made so far.
 */

const CONVENTION_TEXT =
  'Action convention: an action names the direction the TILE slides, not the blank. ' +
  '"up" slides the tile BELOW the blank upward (the blank moves down); ' +
  '"down" slides the tile ABOVE the blank downward (the blank moves up); ' +
  '"right" slides the tile to the LEFT of the blank rightward (the blank moves left); ' +
  '"left" slides the tile to the RIGHT of the blank leftward (the blank moves right).';

/**
 * Parse an action attempt into a canonical direction name. Accepts the
 * documented alternates: any letter case, optional leading verbs
 * ("move", "slide", "press", "go"), single-letter forms (u/d/l/r), and
 * wrapping quotes or backticks.
 * @param {string} text
 * @returns {import('./solver.js').Direction | null}
 */
function parseDirection(text) {
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
  s = s.replace(/^(move|slide|press|go)\s+/, '');
  const names = /** @type {Record<string, Direction>} */ ({ up: 'up', down: 'down', left: 'left', right: 'right', u: 'up', d: 'down', l: 'left', r: 'right' });
  return s in names ? names[s] : null;
}

/**
 * @param {number} size
 * @param {number[][]} board
 * @returns {string} Rendered grid, blank as "_".
 */
function renderBoard(size, board) {
  const width = String(size * size - 1).length;
  /** @type {string[]} */
  const lines = [];
  for (let r = 0; r < size; r++) {
    /** @type {string[]} */
    const cells = [];
    for (let c = 0; c < size; c++) {
      const v = board[r][c];
      cells.push(v === 0 ? '_'.padStart(width) : String(v).padStart(width));
    }
    lines.push(cells.join(' '));
  }
  return lines.join('\n');
}

/**
 * @param {SlidingState} state
 * @returns {boolean}
 */
function solved(state) {
  return isSolved(state.board);
}

export const sliding = {
  spec: {
    id: 'sliding',
    version: '1.1.0',
    title: 'Sliding Tile Puzzle',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['planning', 'spatial']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Sliding tile puzzle on an N x N grid with one blank cell ("_"). Slide tiles until they read 1..N*N-1 left to right, top to bottom, with the blank in the bottom-right corner.',
      CONVENTION_TEXT,
      'Only a tile adjacent to the blank can slide, and it can only slide into the blank. Every action slides exactly one tile.',
      'Action grammar: one of "up", "down", "left", "right".',
      'Documented alternates: uppercase forms ("UP"), single letters ("u", "d", "l", "r"), an optional leading verb ("move up", "slide left", "press down", "go right"), and surrounding quotes or backticks are all accepted.',
      'An action with no tile to slide (for example "down" when the blank is already in the top row) is invalid and consumes an action attempt.',
      'Episodes are scored for efficiency: finishing in the optimal number of moves scores 1.0 and each extra move lowers the score.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'p8',
        rank: 1,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 155,
        publicSeeds: 8,
        params: { size: 3, generation: 'uniform-solvable' },
      },
      {
        id: 'p15-short',
        rank: 2,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 145,
        publicSeeds: 8,
        params: { size: 4, generation: 'banded', bandMin: 20, bandMax: 29, walkLength: 40 },
      },
      {
        id: 'p15-mid',
        rank: 3,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 195,
        publicSeeds: 8,
        params: { size: 4, generation: 'banded', bandMin: 30, bandMax: 39, walkLength: 60 },
      },
      {
        id: 'p15-long',
        rank: 4,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 245,
        publicSeeds: 8,
        params: { size: 4, generation: 'banded', bandMin: 40, bandMax: 49, walkLength: 80 },
      },
    ]),
  },

  /**
   * Deterministic in (tier, seed): the instance, its par, and the par's
   * computation (IDA* with an admissible heuristic) come only from the seed.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {SlidingState}
   */
  reset(tier, seed) {
    const params = /** @type {{ size: number, generation: string, bandMin?: number, bandMax?: number, walkLength?: number }} */ (tier.params);
    /** @type {{ board: number[][], par: number }} */
    let instance;
    if (params.generation === 'uniform-solvable') {
      const generated = generateUniformSolvable(params.size, seed);
      instance = { board: generated.board, par: generated.par };
    } else {
      const generated = generateBanded(
        params.size,
        { min: /** @type {number} */ (params.bandMin), max: /** @type {number} */ (params.bandMax), walkLength: /** @type {number} */ (params.walkLength) },
        seed
      );
      instance = { board: generated.board, par: generated.par };
    }
    return { size: params.size, board: instance.board, par: instance.par, maxActions: tier.maxActions, moveCount: 0 };
  },

  /**
   * @param {SlidingState} state
   * @returns {number | null}
   */
  toAct(state) {
    return solved(state) ? null : 0;
  },

  /**
   * @param {SlidingState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const legal = legalMoves(state.board);
    const size = state.size;
    const header = `Sliding tile puzzle (${size} x ${size}). You are seat ${seat}. Slide tiles until they read 1..${size * size - 1} left to right, top to bottom, blank last.`;
    const convention = CONVENTION_TEXT;
    const budgetLine = `Moves used: ${state.moveCount} of ${state.maxActions}.`;
    const legalText = `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`;
    return {
      text: [header, convention, renderBoard(size, state.board), budgetLine, legalText].join('\n'),
      data: { ...state, you: seat },
    };
  },

  /**
   * @param {SlidingState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (seat !== 0 || solved(state)) return [];
    return legalMoves(state.board);
  },

  /**
   * @param {SlidingState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (seat !== 0 || solved(state)) {
      return { ok: false, error: 'the puzzle is already solved' };
    }
    const direction = parseDirection(text);
    if (direction === null) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a slide; use "up", "down", "left" or "right" (the direction the TILE slides)`,
      };
    }
    const legal = legalMoves(state.board);
    if (!legal.includes(direction)) {
      return {
        ok: false,
        error: `no tile can slide ${direction}: that direction is blocked by the board edge`,
      };
    }
    return { ok: true, action: direction };
  },

  /**
   * @param {SlidingState} state
   * @param {number} seat
   * @param {string} action
   * @returns {SlidingState}
   */
  step(state, seat, action) {
    if (seat !== 0) {
      throw new GauntletRuleError(`sliding is single-seat; seat ${seat} has no turn`);
    }
    if (solved(state)) {
      throw new GauntletRuleError('the puzzle is already solved');
    }
    if (typeof action !== 'string' || !DIRECTIONS.includes(/** @type {'up'} */ (action))) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const legal = legalMoves(state.board);
    if (!legal.includes(/** @type {import('./solver.js').Direction} */ (action))) {
      throw new GauntletRuleError(`no tile can slide ${action}: that direction is blocked by the board edge`);
    }
    const board = /** @type {number[][]} */ (applyTileMove(state.board, /** @type {import('./solver.js').Direction} */ (action)));
    return { ...state, board, moveCount: state.moveCount + 1 };
  },

  /**
   * @param {SlidingState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (!solved(state)) return null;
    const score = Math.min(1, (state.par / Math.max(1, state.moveCount)) ** 2);
    return {
      normalized: [score],
      raw: [{ moves: state.moveCount, par: state.par }],
      reason: `solved in ${state.moveCount} moves (optimal par ${state.par})`,
      solved: true,
      par: state.par,
    };
  },

  /**
   * Budget exhaustion on an efficiency tier: unsolved, zero score. (The tier
   * scores by efficiency, so the runner would supply this too; provided for
   * completeness.)
   *
   * @param {SlidingState} state
   * @returns {Outcome}
   */
  truncate(state) {
    return {
      normalized: [0],
      raw: null,
      reason: `budget exhausted before solving (par ${state.par})`,
      solved: false,
      par: state.par,
    };
  },
};

/** @type {Game<SlidingState>} */
export default sliding;
