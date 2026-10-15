/**
 * 2048 as a Gauntlet game: one seat, perfect information, stochastic (tile
 * spawns), a long-horizon planning benchmark. All randomness comes from the
 * episode seed through the core RNG; no `Math.random`, no clocks, no
 * `node:*` imports, so a seed always replays to the same game.
 *
 * State is plain JSON (board, score, RNG state, status, target), so it
 * survives a round trip and trajectories verify exactly.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { rngFromSeed } from '../../core/rng.js';
import {
  DIRECTIONS,
  emptyCells,
  maxTile,
  observationForBoard,
  slide,
  spawnTile,
} from './rules.js';

/** @import { Game, InformationMode, Observation, Outcome, ParseResult, TierSpec, GameTag } from '../../core/types.js' */
/** @import { RngState } from '../../core/rng.js' */
/** @import { Board, Direction } from './rules.js' */

/**
 * Game state: JSON-serializable.
 *
 * @typedef {object} Game2048State
 * @property {Board} board 4x4 tile values, 0 = empty, rows top to bottom.
 * @property {number} score Accumulated merge score.
 * @property {RngState} rng The episode RNG stream position.
 * @property {'playing' | 'won' | 'dead'} status won = target reached;
 *   dead = board locked (no legal move).
 * @property {number} target Target tile for the tier.
 */

/**
 * @param {TierSpec} tier
 * @returns {number}
 */
function tierTarget(tier) {
  const raw = /** @type {{ target?: * }} */ (tier.params)?.target;
  const target = Number(raw);
  if (
    !Number.isInteger(target) ||
    target < 8 ||
    (target & (target - 1)) !== 0
  ) {
    throw new Error(`2048: tier "${tier.id}" needs an integer power-of-two params.target >= 8, got ${JSON.stringify(raw)}`);
  }
  return target;
}

/**
 * Partial-credit progress: p = (log2(maxTile) - 2) / (log2(target) - 2),
 * clamped to [0, 1]. Reaching the target would be p = 1, but that ends the
 * episode as a win, so truncated/dead scores stay strictly below 1.
 *
 * @param {Board} board
 * @param {number} target
 * @returns {number}
 */
function progress(board, target) {
  const p = (Math.log2(maxTile(board)) - 2) / (Math.log2(target) - 2);
  return Math.min(1, Math.max(0, p));
}

/**
 * @param {number} p
 * @param {number} score
 * @param {number} max
 * @param {string} why
 * @returns {Outcome}
 */
function partialOutcome(p, score, max, why) {
  return {
    normalized: [0.5 * p * p],
    raw: [score],
    reason: `${why} with a max tile of ${max}`,
    solved: false,
    par: null,
  };
}

/**
 * Does any move change the board?
 *
 * @param {Board} board
 * @returns {boolean}
 */
function hasMoves(board) {
  if (emptyCells(board).length > 0) return true;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = board[r][c];
      if (c < 3 && board[r][c + 1] === v && v !== 0) return true;
      if (r < 3 && board[r + 1][c] === v && v !== 0) return true;
    }
  }
  return false;
}

/**
 * @param {Game2048State} state
 * @param {string} why
 * @returns {Outcome}
 */
function partialFromState(state, why) {
  return partialOutcome(progress(state.board, state.target), state.score, maxTile(state.board), why);
}

export const game = {
  spec: {
    id: '2048',
    version: '1.0.0',
    title: '2048',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: true,
    tags: /** @type {GameTag[]} */ (['long-horizon', 'probabilistic']),
    benchmark: true,
    requires: [],
    rulesText: [
      '2048 on a 4x4 grid. Rows are numbered top to bottom, columns left to right; the board is shown with tile values, blanks are empty cells.',
      'Actions: "up", "right", "down", or "left" — slide every tile one step in that direction as far as it goes.',
      'When two tiles with the same number collide during a slide they merge into one tile of double the value, scoring that value; tiles nearest the wall in the slide direction merge first, and a tile merges at most once per move.',
      'A move that changes nothing is not legal and consumes an action attempt without spawning a tile.',
      'After every legal move a new tile spawns in a uniformly chosen empty cell: a 2 with probability 0.9, or a 4 with probability 0.1.',
      'Episode: reach the tier target tile (e.g. 1024) to win and end the episode; if the board locks with no legal move the episode ends.',
      'Documented alternates: "move up", "go left", "slide right", "swipe down", uppercase letters, and surrounding quotes or backticks are all accepted.',
      'Scoring: 1.0 for reaching the target tile; otherwise 0.5 * p^2 where p = (log2(largest tile) - 2) / (log2(target) - 2), applied both when the board locks and when the action budget runs out.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 't256',
        rank: 1,
        scoring: 'outcome',
        maxActions: 300,
        publicSeeds: 20,
        params: { target: 256 },
      },
      {
        id: 't512',
        rank: 2,
        scoring: 'outcome',
        maxActions: 600,
        publicSeeds: 20,
        params: { target: 512 },
      },
      {
        id: 't1024',
        rank: 3,
        scoring: 'outcome',
        maxActions: 1200,
        publicSeeds: 20,
        params: { target: 1024 },
      },
      {
        id: 't2048',
        rank: 4,
        scoring: 'outcome',
        maxActions: 2400,
        publicSeeds: 20,
        params: { target: 2048 },
      },
    ]),
  },

  /**
   * Deterministic in (tier, seed): seed the RNG, then spawn two starting
   * tiles (value first, then cell — see spawnTile in rules.js).
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {Game2048State}
   */
  reset(tier, seed) {
    const target = tierTarget(tier);
    /** @type {Board} */
    const board = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    let rng = rngFromSeed(seed);
    let firstSpawn = spawnTile(board, rng);
    let secondSpawn = spawnTile(firstSpawn.board, firstSpawn.rng);
    return {
      board: secondSpawn.board,
      score: 0,
      rng: secondSpawn.rng,
      status: 'playing',
      target,
    };
  },

  /**
   * @param {Game2048State} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * @param {Game2048State} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const base = observationForBoard(state.board, state.score);
    const legal =
      state.status === 'playing'
        ? DIRECTIONS.filter((dir) => slide(state.board, dir).moved).sort()
        : [];
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : 'Legal actions: none (game over).';
    const statusText =
      state.status === 'won'
        ? `Game over: the ${state.target} tile is reached — win.`
        : state.status === 'dead'
          ? 'Game over: the board is locked, no move changes it.'
          : `Reach the ${state.target} tile. Tiles: 2 spawns (90%) or 4 (10%) after each move; equal tiles merge once per move.`;
    return {
      text: [
        `2048, tier target ${state.target}. You are seat ${seat}. Score: ${state.score}.`,
        base.text,
        statusText,
        legalText,
      ].join('\n'),
      data: {
        board: state.board.map((row) => row.slice()),
        score: state.score,
        target: state.target,
      },
    };
  },

  /**
   * Legal directions, sorted lexicographically: down, left, right, up.
   *
   * @param {Game2048State} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== 0) return [];
    return DIRECTIONS.filter((dir) => slide(state.board, dir).moved).sort();
  },

  /**
   * @param {Game2048State} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== 0) {
      return { ok: false, error: `2048 has one seat; seat ${seat} does not act` };
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
    s = s.toLowerCase().replace(/^(move|go|slide|swipe|shift)\s+/, '');
    if (!/^(up|down|left|right)$/.test(s)) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a direction; use up, right, down, or left`,
      };
    }
    return { ok: true, action: s };
  },

  /**
   * Apply a slide, spawn one tile, then settle win/dead. Throws
   * GauntletRuleError for anything outside legalActions (including a legal
   * direction that changes nothing — such moves are not legal and never
   * spawn).
   *
   * @param {Game2048State} state
   * @param {number} seat
   * @param {string} action
   * @returns {Game2048State}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== 0) {
      throw new GauntletRuleError(`it is seat 0's turn, not seat ${seat}'s`);
    }
    if (typeof action !== 'string' || !DIRECTIONS.includes(/** @type {Direction} */ (action))) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const result = slide(state.board, /** @type {Direction} */ (action));
    if (!result.moved) {
      throw new GauntletRuleError(`${action} changes nothing on this board`);
    }
    const spawned = spawnTile(result.board, state.rng);
    const board = spawned.board;
    let status = /** @type {Game2048State['status']} */ ('playing');
    if (maxTile(board) >= state.target) {
      status = 'won';
    } else if (!hasMoves(board)) {
      status = 'dead';
    }
    return {
      board,
      score: state.score + result.gained,
      rng: spawned.rng,
      status,
      target: state.target,
    };
  },

  /**
   * @param {Game2048State} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    if (state.status === 'won') {
      return {
        normalized: [1],
        raw: [state.score],
        reason: `reached the ${state.target} tile with score ${state.score}`,
        solved: false,
        par: null,
      };
    }
    return partialFromState(state, 'the board locked');
  },

  /**
   * Budget ran out on an outcome tier: score the current position by the
   * same partial-credit curve.
   *
   * @param {Game2048State} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    return partialFromState(state, 'the action budget ran out');
  },
};

/** @type {Game<Game2048State>} */
export default game;
