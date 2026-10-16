/**
 * Sudoku for the PlayKit Gauntlet: classic 9x9 plus a 4x4 on-ramp, every
 * puzzle unique-solution and graded by the human solving techniques it
 * needs. A tier is a technique ceiling, not a clue count:
 *
 * - `mini-4x4` — 4x4, 2x2 boxes, singles only (the on-ramp).
 * - `easy` — 9x9, singles only.
 * - `medium` — 9x9, needs naked/hidden pairs or pointing/claiming.
 * - `hard` — 9x9, needs X-wing/XY-wing or techniques beyond the ladder;
 *   the engine baseline solves every seed privately at par.
 *
 * Scoring is efficiency: par is the number of empty cells at reset, so wrong
 * placements and erasures cost actions. A placement that repeats a digit
 * already visible in its row, column or box is rejected as invalid (the
 * duplicate is right there on the board — rejecting it catches typos, not
 * deductions); a locally consistent but globally wrong placement is allowed
 * and scored, because telling those apart is exactly the skill measured.
 * Given the unique solution, a full locally consistent grid always IS the
 * solution, so the episode ends the moment the last cell lands.
 *
 * No `node:*` imports; every random choice comes from the core RNG seeded by
 * the episode seed.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { generateForTier } from './solver.js';

/** @import { Game, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */

/**
 * @typedef {object} SudokuTierParams
 * @property {number} size 4 or 9.
 * @property {number} boxRows
 * @property {number} boxCols
 * @property {'mini' | 'easy' | 'medium' | 'hard'} gradeKey Rejection-sampling
 *   key in the generator.
 */

/**
 * Game state: plain JSON. `givens` are immutable clues; `cells` is the live
 * grid (0 = empty); `solution` is the unique completed grid (never observed).
 *
 * @typedef {object} SudokuState
 * @property {number} size
 * @property {number} boxRows
 * @property {number} boxCols
 * @property {number[]} givens
 * @property {number[]} cells
 * @property {number[]} solution
 * @property {number} par Empty cells at reset — the efficiency par.
 * @property {number} clues Given clues generated.
 * @property {number} generationAttempts Rejection-sampling attempts used.
 * @property {'playing' | 'solved' | 'stuck'} status 'stuck' is defensive
 *   only: with a unique solution and visible-duplicate rejection it is
 *   unreachable (tests pin this over 500 puzzles per tier).
 */

const DIMS = /** @type {const} */ ({
  mini: { size: 4, boxRows: 2, boxCols: 2 },
  classic: { size: 9, boxRows: 3, boxCols: 3 },
});

/** @type {{ id: string, rank: number, gradeKey: 'mini' | 'easy' | 'medium' | 'hard', dims: { size: number, boxRows: number, boxCols: number }, maxActions: number }[]} */
const TIER_DEFS = [
  { id: 'mini-4x4', rank: 1, gradeKey: 'mini', dims: DIMS.mini, maxActions: 26 },
  { id: 'easy', rank: 2, gradeKey: 'easy', dims: DIMS.classic, maxActions: 76 },
  { id: 'medium', rank: 3, gradeKey: 'medium', dims: DIMS.classic, maxActions: 96 },
  { id: 'hard', rank: 4, gradeKey: 'hard', dims: DIMS.classic, maxActions: 116 },
];

const PLACE_RE = /^place\s+(\d+)\s+(\d+)\s+(\d+)$/;
const ERASE_RE = /^erase\s+(\d+)\s+(\d+)$/;

/**
 * First visible unit where digit d already appears relative to (r, c), or
 * null when the placement is locally consistent.
 *
 * @param {SudokuState} state
 * @param {number} r 0-based row.
 * @param {number} c 0-based column.
 * @param {number} d
 * @returns {'row' | 'column' | 'box' | null}
 */
function conflictUnit(state, r, c, d) {
  const { size } = state;
  for (let cc = 0; cc < size; cc++) {
    if (cc !== c && state.cells[r * size + cc] === d) return 'row';
  }
  for (let rr = 0; rr < size; rr++) {
    if (rr !== r && state.cells[rr * size + c] === d) return 'column';
  }
  const r0 = Math.floor(r / state.boxRows) * state.boxRows;
  const c0 = Math.floor(c / state.boxCols) * state.boxCols;
  for (let rr = r0; rr < r0 + state.boxRows; rr++) {
    for (let cc = c0; cc < c0 + state.boxCols; cc++) {
      if ((rr !== r || cc !== c) && state.cells[rr * size + cc] === d) {
        return 'box';
      }
    }
  }
  return null;
}

/**
 * Canonical action strings, sorted: `place r c d` on every locally legal
 * digit of every empty cell, `erase r c` on every player-filled cell.
 *
 * @param {SudokuState} state
 * @returns {string[]}
 */
function legalActionList(state) {
  if (state.status !== 'playing') return [];
  /** @type {string[]} */
  const actions = [];
  const { size } = state;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      if (state.cells[i]) {
        if (!state.givens[i]) actions.push(`erase ${r + 1} ${c + 1}`);
      } else {
        for (let d = 1; d <= size; d++) {
          if (!conflictUnit(state, r, c, d)) {
            actions.push(`place ${r + 1} ${c + 1} ${d}`);
          }
        }
      }
    }
  }
  return actions.sort();
}

/**
 * Render the grid with 1-based row and column labels matching the action
 * grammar: givens as plain digits, player entries in parentheses, empty
 * cells as dots, a `|` separator between box columns.
 *
 * @param {SudokuState} state
 * @returns {string}
 */
function renderGrid(state) {
  const { size } = state;
  const boxCols = size / state.boxCols;
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const header = [];
  for (let c = 0; c < size; c++) {
    if (c > 0 && c % boxCols === 0) header.push('|');
    header.push(` ${c + 1} `);
  }
  lines.push(`${' '.repeat(String(size).length + 2)}${header.join('')}`);
  for (let r = 0; r < size; r++) {
    /** @type {string[]} */
    const tokens = [];
    for (let c = 0; c < size; c++) {
      if (c > 0 && c % boxCols === 0) tokens.push('|');
      const i = r * size + c;
      const v = state.cells[i];
      tokens.push(
        v ? (state.givens[i] ? ` ${v} ` : `(${v})`) : ' . '
      );
    }
    lines.push(`${r + 1}  ${tokens.join('')}`);
  }
  return lines.join('\n');
}

/**
 * Strict canonical parser, shared by parseAction and step. Coordinates are
 * 1-based and digits 1..size, matching the observation labels exactly.
 *
 * @param {SudokuState} state
 * @param {string} text
 * @returns {ParseResult}
 */
function parseCanonical(state, text) {
  const placeMatch = PLACE_RE.exec(text);
  if (placeMatch) {
    const r = Number(placeMatch[1]);
    const c = Number(placeMatch[2]);
    const d = Number(placeMatch[3]);
    if (r < 1 || r > state.size || c < 1 || c > state.size) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) is outside the grid; rows and columns are 1-${state.size}`,
      };
    }
    if (d < 1 || d > state.size) {
      return {
        ok: false,
        error: `digit ${d} is outside the range 1-${state.size}`,
      };
    }
    const i = (r - 1) * state.size + (c - 1);
    if (state.givens[i]) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) holds a given clue and cannot be changed`,
      };
    }
    if (state.cells[i]) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) already holds ${state.cells[i]} — erase it before placing a new digit`,
      };
    }
    const conflict = conflictUnit(state, r - 1, c - 1, d);
    if (conflict) {
      const where =
        conflict === 'row'
          ? `row ${r}`
          : conflict === 'column'
            ? `column ${c}`
            : `the box containing (row ${r}, column ${c})`;
      return {
        ok: false,
        error: `digit ${d} already appears in ${where}, so the placement repeats a visible digit`,
      };
    }
    return { ok: true, action: `place ${r} ${c} ${d}` };
  }
  const eraseMatch = ERASE_RE.exec(text);
  if (eraseMatch) {
    const r = Number(eraseMatch[1]);
    const c = Number(eraseMatch[2]);
    if (r < 1 || r > state.size || c < 1 || c > state.size) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) is outside the grid; rows and columns are 1-${state.size}`,
      };
    }
    const i = (r - 1) * state.size + (c - 1);
    if (state.givens[i]) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) is a given clue and cannot be erased`,
      };
    }
    if (!state.cells[i]) {
      return {
        ok: false,
        error: `cell (row ${r}, column ${c}) is already empty, so erase would change nothing`,
      };
    }
    return { ok: true, action: `erase ${r} ${c}` };
  }
  return {
    ok: false,
    error: `cannot parse ${JSON.stringify(text)}; the action grammar is "place <row> <column> <digit>" or "erase <row> <column>" with 1-based indices and digits 1-${state.size}`,
  };
}

/**
 * Shared outcome constructor for the three endings.
 *
 * @param {SudokuState} state
 * @param {'solved' | 'stuck' | 'truncated'} ending
 * @returns {Outcome}
 */
function finishOutcome(state, ending) {
  let correct = 0;
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] && state.cells[i] === state.solution[i] && !state.givens[i]) {
      correct++;
    }
  }
  if (ending === 'solved') {
    return {
      normalized: [1],
      raw: [state.par],
      reason: `grid complete — matches the unique solution (par ${state.par})`,
      solved: true,
      par: state.par,
    };
  }
  if (ending === 'stuck') {
    return {
      normalized: [0],
      raw: [correct],
      reason: 'grid complete but it does not match the unique solution',
      solved: false,
      par: state.par,
    };
  }
  return {
    normalized: [0],
    raw: [correct],
    reason: `truncated: action budget exhausted with ${correct} of ${state.par} cells filled correctly`,
    solved: false,
    par: state.par,
  };
}

/**
 * The Sudoku game.
 *
 * @type {Game<SudokuState>}
 */
export const game = {
  spec: {
    id: 'sudoku',
    version: '1.0.0',
    title: 'Sudoku',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('hidden'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['deduction', 'spatial']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Sudoku: fill the grid so every row, every column and every box contains each digit exactly once.',
      'The classic tiers are 9x9 with 3x3 boxes (digits 1-9); the mini tier is 4x4 with 2x2 boxes (digits 1-4).',
      'Rows are numbered 1 (top) to N (bottom) and columns 1 (left) to N (right); the observation grid labels every row and column with exactly those numbers, all 1-based.',
      '"place <row> <column> <digit>" writes a digit into an empty cell, e.g. "place 1 3 7" puts a 7 in row 1, column 3.',
      'A placement that repeats a digit already visible in the same row, column or box is invalid: it consumes an attempt and changes nothing.',
      'A placement that is locally consistent but globally wrong is accepted — it costs an action and must be erased before the puzzle can be finished.',
      '"erase <row> <column>" clears a cell you filled; given clues (shown as plain digits) can never be placed over or erased.',
      'In the grid, given clues are plain digits, your own entries are shown in parentheses like (5), and empty cells show a dot.',
      'The episode ends when the last empty cell is filled; every puzzle has exactly one solution, and scoring is efficiency-based: par is the number of empty cells at the start, so wrong placements and erasures cost actions.',
      'Documented alternates: "put", "set" or "fill" for place, "remove", "clear" or "delete" for erase, surrounding quotes or backticks, and extra whitespace are all accepted.',
      'Invalid actions consume an attempt from the budget without changing the grid.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ (
      TIER_DEFS.map((def) => ({
        id: def.id,
        rank: def.rank,
        scoring: /** @type {'efficiency'} */ ('efficiency'),
        maxActions: def.maxActions,
        publicSeeds: 25,
        parKind: /** @type {'optimal'} */ ('optimal'),
        params: /** @type {SudokuTierParams} */ ({
          size: def.dims.size,
          boxRows: def.dims.boxRows,
          boxCols: def.dims.boxCols,
          gradeKey: def.gradeKey,
        }),
      }))
    ),
  },

  /**
   * Deterministic in (tier, seed): rejection-samples a unique-solution
   * puzzle whose technique grade matches the tier. Memoized per (tier, seed)
   * because generation is the expensive step; callers still get a fresh deep
   * copy, and step never mutates state.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {SudokuState}
   */
  reset(tier, seed) {
    const params = /** @type {SudokuTierParams} */ (tier.params);
    const key = `${tier.id}/${seed}`;
    let cached = /** @type {SudokuState | undefined} */ (GENERATION_CACHE.get(key));
    if (!cached) {
      const dims = {
        size: params.size,
        boxRows: params.boxRows,
        boxCols: params.boxCols,
      };
      const gen = generateForTier(dims, params.gradeKey, seed);
      const par = gen.givens.filter((v) => v === 0).length;
      cached = {
        size: params.size,
        boxRows: params.boxRows,
        boxCols: params.boxCols,
        givens: gen.givens,
        cells: gen.givens.slice(),
        solution: gen.solution,
        par,
        clues: gen.clues,
        generationAttempts: gen.attempts,
        status: 'playing',
      };
      GENERATION_CACHE.set(key, cached);
    }
    return JSON.parse(JSON.stringify(cached));
  },

  /**
   * @param {SudokuState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * The observation never reveals the solution: the grid, its labels, the
   * tallies and the legal-action list are all public.
   *
   * @param {SudokuState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    void seat;
    const legal = legalActionList(state);
    const empty = state.cells.filter((v) => v === 0).length;
    const header =
      `Sudoku ${state.size}x${state.size} (${state.boxRows}x${state.boxCols} boxes, digits 1-${state.size}); rows and columns are 1-based.`;
    const legend =
      'Grid: plain digit = given clue, (digit) = your entry, "." = empty; row numbers on the left, column numbers on top, matching the action grammar.';
    const status =
      state.status === 'playing'
        ? `Playing: ${empty} empty cell${empty === 1 ? '' : 's'} remaining (par ${state.par}).`
        : state.status === 'solved'
          ? 'Game over: grid complete — matches the unique solution.'
          : 'Game over: grid complete but it does not match the unique solution.';
    const legalText =
      state.status !== 'playing'
        ? 'Legal actions: none (game over).'
        : legal.length > 0 && legal.length <= 64
          ? `Legal actions: ${legal.join(', ')}.`
          : `Legal actions: ${legal.length} available — too many to list. Grammar: "place <row> <column> <digit>" or "erase <row> <column>" (1-based).`;
    return {
      text: [header, legend, renderGrid(state), status, legalText].join('\n'),
      data: {
        size: state.size,
        boxRows: state.boxRows,
        boxCols: state.boxCols,
        givens: state.givens,
        cells: state.cells,
        emptyCells: empty,
        status: state.status,
      },
    };
  },

  /**
   * @param {SudokuState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    void seat;
    return legalActionList(state);
  },

  /**
   * Strict parse with alternates and a helpful error on everything else.
   *
   * @param {SudokuState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    void seat;
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    let s = String(text).trim().toLowerCase();
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s
      .replace(/^(put|set|fill)\s+/, 'place ')
      .replace(/^(remove|clear|delete)\s+/, 'erase ');
    s = s.replace(/\s+/g, ' ');
    return parseCanonical(state, s);
  },

  /**
   * Pure: applies the action to a fresh copy and never mutates its input.
   *
   * @param {SudokuState} state
   * @param {number} seat
   * @param {string} action
   * @returns {SudokuState}
   */
  step(state, seat, action) {
    void seat;
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    const parsed = parseCanonical(state, String(action).trim().toLowerCase());
    if (!parsed.ok) {
      throw new GauntletRuleError(parsed.error);
    }
    const canonical = parsed.action;
    const placeMatch = /^place (\d+) (\d+) (\d+)$/.exec(canonical);
    const eraseMatch = /^erase (\d+) (\d+)$/.exec(canonical);
    if (placeMatch) {
      const r = Number(placeMatch[1]);
      const c = Number(placeMatch[2]);
      const d = Number(placeMatch[3]);
      const i = (r - 1) * state.size + (c - 1);
      const cells = state.cells.slice();
      cells[i] = d;
      let status = /** @type {SudokuState['status']} */ ('playing');
      if (!cells.includes(0)) {
        status = cells.every((v, idx) => v === state.solution[idx])
          ? 'solved'
          : 'stuck';
      }
      return { ...state, cells, status };
    }
    if (eraseMatch) {
      const r = Number(eraseMatch[1]);
      const c = Number(eraseMatch[2]);
      const i = (r - 1) * state.size + (c - 1);
      const cells = state.cells.slice();
      cells[i] = 0;
      return { ...state, cells, status: 'playing' };
    }
    throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
  },

  /**
   * @param {SudokuState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    return finishOutcome(state, state.status);
  },

  /**
   * Budget truncation on this efficiency tier: unsolved with the tally of
   * correctly filled cells as the raw diagnostic.
   *
   * @param {SudokuState} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return finishOutcome(state, state.status);
    }
    return finishOutcome(state, 'truncated');
  },
};

/**
 * Generation cache: one rejection-sampling run per (tier, seed) per process.
 * `reset` still returns a fresh deep copy per call, so callers never share
 * structure and the pure-function contract holds.
 *
 * @type {Map<string, SudokuState>}
 */
const GENERATION_CACHE = new Map();

export default game;
