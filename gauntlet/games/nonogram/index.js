/**
 * Nonogram (Picross): reconstruct a unique cell grid from run-length clues.
 *
 * One seat, perfect information: the clues shown to the agent uniquely
 * determine the solution, so nothing is hidden — the work is deduction and
 * bookkeeping across a long horizon. Episodes are scored on efficiency: par
 * is the number of filled cells in the solution, and solved episodes score
 * min(1, (par / actions)²), so agents that commit whole rows with row
 * actions are rewarded and agents that fill cell-by-cell pay for it.
 *
 * Tiers are graded by a line solver: line-solvable tiers accept only puzzles
 * a row/column deduction loop can finish, while the probe tier accepts only
 * unique puzzles the line solver cannot finish — they require at least one
 * contradiction probe ("if this cell were empty, row 4's clue fails").
 *
 * No `node:*` imports.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { puzzleFor } from './generator.js';
import { clueOfPattern } from './solver.js';

/** @import { Game, InformationMode, GameTag, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */

/**
 * Candidate fill density for generated puzzles. Measured (see the PR): at
 * 0.55 the line tiers accept roughly the first or second candidate and the
 * probe tier about one in 48, with generation well inside the reset budget.
 *
 * @type {number}
 */
const DENSITY = 0.55;

/**
 * Tier definitions. maxActions is five times a headroom-inflated measured
 * maximum par (5x5 max 19, 10x10 max 68, 15x15 max 141 line / 127 probe,
 * sampled over 24 public seeds per tier), so even cell-by-cell agents fit.
 *
 * @type {Array<{ id: string, rows: number, cols: number, grade: 'line' | 'probe', maxActions: number, blurb: string }>}
 */
const TIER_DEFS = [
  {
    id: 'tiny',
    rows: 5,
    cols: 5,
    grade: 'line',
    maxActions: 110,
    blurb: 'tier tiny: a 5 by 5 grid solvable by row-by-row and column-by-column deduction alone.',
  },
  {
    id: 'classic',
    rows: 10,
    cols: 10,
    grade: 'line',
    maxActions: 390,
    blurb: 'tier classic: a 10 by 10 grid, still solvable by line deduction alone but longer.',
  },
  {
    id: 'grand',
    rows: 15,
    cols: 15,
    grade: 'line',
    maxActions: 810,
    blurb: 'tier grand: a 15 by 15 grid, line-solvable but at full scale.',
  },
  {
    id: 'probe',
    rows: 15,
    cols: 15,
    grade: 'probe',
    maxActions: 810,
    blurb:
      'tier probe: a 15 by 15 grid with a unique solution that line deduction alone cannot finish; at some point you must test a hypothesis (if this cell were empty, some row or column clue becomes impossible) and use the contradiction.',
  },
];

/**
 * The rules and action grammar every agent sees. Official-track agents get
 * only this text and the observations, so it must be complete.
 *
 * @type {string}
 */
const RULES_TEXT = [
  'Nonogram (Picross): reconstruct the unique grid that matches the run-length clues. Rows are numbered from the top and columns from the left, both starting at 1.',
  'The row clues run down the right side, one list per row; the column clues run along the top, one list per column. A clue list like 3 1 means the line contains, in order, a run of 3 consecutive filled cells and (separated by at least one empty cell) a run of 1 filled cell; the clue 0 means the line is entirely empty.',
  'Marks: "#" filled, "x" crossed (definitively empty), "." unknown. In row-action patterns "." means crossed.',
  'Winning: the episode is solved when every filled cell is marked "#" and no "#" is placed on a cell that should be empty. Crosses are never required to win.',
  'Action grammar: "fill R C" marks cell (row R, column C) filled; "cross R C" crosses it out; "clear R C" resets it to unknown. Coordinates are 1-based, row first, column second.',
  'Action grammar: "row R PATTERN" sets the whole row R at once, where PATTERN is a string of "#" and "." with one character per column ("#" filled, "." crossed). The pattern must match the row clue exactly, and it replaces any marks already in the row.',
  'A fill or cross that contradicts the true grid is a legal action but makes the episode unsolvable, so never commit a cell you cannot justify.',
  'Efficiency scoring: par is the number of filled cells in the solution; solving in fewer actions scores higher (row actions help). The budget is generous but finite: wasted and invalid actions all count against it.',
].join(' ');

/**
 * All row patterns matching a clue: strings of "#" and "." over `cols`
 * cells whose runs equal `clue`. Deterministic, ascending in the position of
 * the first filled cell.
 *
 * @param {number} cols
 * @param {number[]} clue
 * @returns {string[]}
 */
function rowPatterns(cols, clue) {
  const runs = clue.filter((run) => run > 0);
  if (runs.length === 0) {
    return ['.'.repeat(cols)];
  }
  /** @type {string[]} */
  const out = [];
  const line = new Array(cols).fill(0);
  /**
   * @param {number} k
   * @param {number} pos
   * @returns {void}
   */
  const place = (k, pos) => {
    if (k === runs.length) {
      for (let i = pos; i < cols; i++) line[i] = 0;
      out.push(line.map((cell) => (cell === 1 ? '#' : '.')).join(''));
      return;
    }
    const rest = runs
      .slice(k + 1)
      .reduce((sum, run) => sum + run, 0) + (runs.length - k - 1);
    const maxStart = cols - rest - runs[k];
    for (let start = pos; start <= maxStart; start++) {
      // Clear the whole tail first: deeper branches leave filled cells
      // behind, and only a full reset makes each push independent of the
      // recursion history.
      for (let i = pos; i < cols; i++) line[i] = 0;
      for (let i = start; i < start + runs[k]; i++) line[i] = 1;
      place(k + 1, start + runs[k] + 1);
    }
  };
  place(0, 0);
  return out;
}

/**
 * Canonical actions per tier shape, cached: cell actions are static per grid
 * size and row actions static per row clues, and `legalActions` runs every
 * ply. Well over 64 entries, so observations do not list them.
 *
 * @type {Map<string, string[]>}
 */
const CANONICAL_ACTIONS_CACHE = new Map();

const CANONICAL_ACTIONS_LIMIT = 16;

/**
 * @param {number} rows
 * @param {number} cols
 * @param {number[][]} rowClues
 * @returns {string[]} Sorted canonical actions; callers must not mutate.
 */
function canonicalActionsFor(rows, cols, rowClues) {
  const key = `${rows}x${cols}|${JSON.stringify(rowClues)}`;
  const hit = CANONICAL_ACTIONS_CACHE.get(key);
  if (hit) return hit;
  /** @type {string[]} */
  const actions = [];
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      actions.push(`fill ${r} ${c}`, `cross ${r} ${c}`, `clear ${r} ${c}`);
    }
    for (const pattern of rowPatterns(cols, rowClues[r - 1])) {
      actions.push(`row ${r} ${pattern}`);
    }
  }
  actions.sort();
  if (CANONICAL_ACTIONS_CACHE.size >= CANONICAL_ACTIONS_LIMIT) {
    const oldest = CANONICAL_ACTIONS_CACHE.keys().next().value;
    if (oldest !== undefined) CANONICAL_ACTIONS_CACHE.delete(oldest);
  }
  CANONICAL_ACTIONS_CACHE.set(key, actions);
  return actions;
}

/**
 * @typedef {object} NonogramState
 * @property {string} seed Episode seed (never revealed in observations).
 * @property {string} tierId
 * @property {number} rows
 * @property {number} cols
 * @property {number[][]} rowClues
 * @property {number[][]} colClues
 * @property {string[]} solution The grid as '#'/'.' strings per row.
 * @property {number} par Filled cells in the solution.
 * @property {number[][]} marks 0 unknown, 1 filled, 2 crossed, per cell.
 * @property {number} actions Valid actions taken so far.
 * @property {'playing' | 'solved'} status
 */

/**
 * @param {number} rows
 * @param {number} cols
 * @returns {number[][]}
 */
function blankMarks(rows, cols) {
  const marks = [];
  for (let r = 0; r < rows; r++) {
    marks.push(new Array(cols).fill(0));
  }
  return marks;
}

/**
 * @param {number[][]} marks
 * @param {string[]} solution
 * @returns {{ filled: number, wrong: number }}
 */
function scoreMarks(marks, solution) {
  let filled = 0;
  let wrong = 0;
  for (let r = 0; r < marks.length; r++) {
    for (let c = 0; c < marks[r].length; c++) {
      if (marks[r][c] === 1) {
        filled++;
        if (solution[r][c] !== '#') wrong++;
      }
    }
  }
  return { filled, wrong };
}

/**
 * Whether the marks complete the puzzle: every filled cell marked and no
 * filled cell on a cell that should be empty.
 *
 * @param {number[][]} marks
 * @param {string[]} solution
 * @param {number} par
 * @returns {boolean}
 */
function isSolved(marks, solution, par) {
  const { filled, wrong } = scoreMarks(marks, solution);
  return filled === par && wrong === 0;
}

/**
 * Column header lines for the grid: a tens line (when columns reach 10) and
 * a units line, each digit column aligned over its grid cell.
 *
 * @param {number} rows
 * @param {number} cols
 * @returns {string[]}
 */
function headerLines(rows, cols) {
  const gutter = String(rows).length + 2; // row number + " |"
  if (cols <= 9) {
    /** @type {string[]} */
    const units = [];
    for (let c = 1; c <= cols; c++) units.push(String(c));
    return [' '.repeat(gutter) + units.join(' ')];
  }
  const tens = [];
  const units = [];
  for (let c = 1; c <= cols; c++) {
    const label = String(c);
    tens.push(label.length === 2 ? label[0] : ' ');
    units.push(label.length === 2 ? label[1] : label);
  }
  // Two-digit headers need two characters per cell column; the single-digit
  // tens line still aligns because every cell renders as one char + space.
  return [
    ' '.repeat(gutter) + tens.join('  '),
    ' '.repeat(gutter) + units.join('  '),
  ];
}

/**
 * @param {string} rowPattern
 * @param {number} cols
 * @returns {number[]}
 */
function rowMarksFromPattern(rowPattern, cols) {
  const marks = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    marks[c] = rowPattern[c] === '#' ? 1 : 2;
  }
  return marks;
}

export const nonogram = {
  spec: {
    id: 'nonogram',
    version: '1.0.0',
    title: 'Nonogram',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {GameTag[]} */ (['deduction', 'long-horizon']),
    benchmark: true,
    requires: [],
    rulesText: RULES_TEXT,
    tiers: /** @type {TierSpec[]} */ (
      TIER_DEFS.map((def, index) => ({
        id: def.id,
        rank: index + 1,
        scoring: /** @type {'efficiency'} */ ('efficiency'),
        maxActions: def.maxActions,
        publicSeeds: 25,
        parKind: /** @type {'reference'} */ ('reference'),
        params: { rows: def.rows, cols: def.cols, grade: def.grade },
      }))
    ),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {NonogramState}
   */
  reset(tier, seed) {
    const { rows, cols, grade } = /** @type {{ rows: number, cols: number, grade: 'line' | 'probe' }} */ (tier.params);
    const puzzle = puzzleFor({
      rows,
      cols,
      density: DENSITY,
      lineSolvable: grade === 'line',
      seed,
    });
    return {
      seed,
      tierId: tier.id,
      rows,
      cols,
      rowClues: puzzle.rowClues,
      colClues: puzzle.colClues,
      solution: puzzle.solution,
      par: puzzle.par,
      marks: blankMarks(rows, cols),
      actions: 0,
      status: 'playing',
    };
  },

  /**
   * @param {NonogramState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * The observation shows the full clue set and the agent's own marks, never
   * the solution or the seed.
   *
   * @param {NonogramState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    void seat;
    const gutter = String(state.rows).length;
    /** @type {string[]} */
    const lines = [
      `Nonogram ${state.rows} by ${state.cols}, tier ${state.tierId}. Reconstruct the unique grid matching the clues.`,
      'Marks: "#" filled, "x" crossed, "." unknown. Cell actions: "fill R C", "cross R C", "clear R C" (rows from the top, columns from the left, 1-based). Row action: "row R <pattern of # and .>" sets row R in one action and must match the row clue.',
      ...headerLines(state.rows, state.cols),
    ];
    const widestClue = Math.max(...state.rowClues.map((clue) => clue.join(' ').length), 1);
    for (let r = 0; r < state.rows; r++) {
      const cells = state.marks[r]
        .map((mark) => (mark === 1 ? '#' : mark === 2 ? 'x' : '.'))
        .join(' ');
      const clueText = state.rowClues[r].join(' ');
      lines.push(
        `${String(r + 1).padStart(gutter)} |${cells} | ${clueText.padStart(widestClue)}`
      );
    }
    const remaining = Math.max(0, budgetOf(state) - state.actions);
    if (state.status === 'solved') {
      lines.push(`Solved in ${state.actions} action(s).`);
    } else {
      lines.push(
        `Actions used ${state.actions} of ${budgetOf(state)} (${remaining} left). Column clues (top to bottom per column): ${state.colClues
          .map((clue) => clue.join(' '))
          .join('; ')}.`
      );
    }
    return {
      text: lines.join('\n'),
      data: {
        rows: state.rows,
        cols: state.cols,
        rowClues: state.rowClues.map((clue) => [...clue]),
        colClues: state.colClues.map((clue) => [...clue]),
        marks: state.marks.map((row) => [...row]),
        actionsUsed: state.actions,
        actionsRemaining: remaining,
        status: state.status,
      },
    };
  },

  /**
   * Every cell action and every clue-matching row pattern is always legal;
   * wrong marks are the agent's problem and simply lose the episode.
   *
   * @param {NonogramState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== 0) return [];
    return canonicalActionsFor(state.rows, state.cols, state.rowClues);
  },

  /**
   * @param {NonogramState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== 0) {
      return { ok: false, error: `unknown seat ${seat}` };
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
    s = s.replace(/^action:\s*/i, '');
    const cell = /^(fill|cross|clear)\s+(\d{1,3})\s*[,.\s]\s*(\d{1,3})$/i.exec(s);
    if (cell) {
      const verb = cell[1].toLowerCase();
      const r = Number(cell[2]);
      const c = Number(cell[3]);
      if (r < 1 || r > state.rows || c < 1 || c > state.cols) {
        return {
          ok: false,
          error: `cell (${r}, ${c}) is off the ${state.rows} by ${state.cols} grid; rows and columns run 1 to ${Math.max(
            state.rows,
            state.cols
          )}, e.g. "fill 1 1"`,
        };
      }
      return { ok: true, action: `${verb} ${r} ${c}` };
    }
    const row = /^row\s+(\d{1,3})\s*[,:\s]\s*([#.]+)$/i.exec(s);
    if (row) {
      const r = Number(row[1]);
      const pattern = row[2];
      if (r < 1 || r > state.rows) {
        return {
          ok: false,
          error: `row action names row ${r} but the grid has ${state.rows} row(s)`,
        };
      }
      if (pattern.length !== state.cols) {
        return {
          ok: false,
          error: `row pattern must have exactly ${state.cols} character(s) of "#" and "." (one per column), got ${pattern.length}`,
        };
      }
      const runs = clueOfPattern(pattern);
      const expected = state.rowClues[r - 1];
      if (JSON.stringify(runs) !== JSON.stringify(expected)) {
        return {
          ok: false,
          error: `pattern runs [${runs.join(' ')}] do not match row ${r}'s clue [${expected.join(' ')}]`,
        };
      }
      return { ok: true, action: `row ${r} ${pattern}` };
    }
    return {
      ok: false,
      error: `cannot parse ${JSON.stringify(String(text))} as a nonogram action; use "fill R C", "cross R C", "clear R C", or "row R <pattern of # and .>"`,
    };
  },

  /**
   * @param {NonogramState} state
   * @param {number} seat
   * @param {string} action
   * @returns {NonogramState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== 0) {
      throw new GauntletRuleError(`unknown seat ${seat}`);
    }
    const parsed = nonogram.parseAction(state, seat, action);
    if (!parsed.ok) {
      throw new GauntletRuleError(parsed.error);
    }
    const canonical = parsed.action;
    const marks = state.marks.map((row) => [...row]);
    if (canonical.startsWith('row ')) {
      const [, rText, pattern] = canonical.split(' ');
      marks[Number(rText) - 1] = rowMarksFromPattern(pattern, state.cols);
    } else {
      const [verb, rText, cText] = canonical.split(' ');
      const r = Number(rText) - 1;
      const c = Number(cText) - 1;
      marks[r][c] = verb === 'fill' ? 1 : verb === 'cross' ? 2 : 0;
    }
    const actions = state.actions + 1;
    const status = isSolved(marks, state.solution, state.par)
      ? /** @type {NonogramState['status']} */ ('solved')
      : state.status;
    return { ...state, marks, actions, status };
  },

  /**
   * @param {NonogramState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    // status 'solved' is the only terminal state: a ruined grid never
    // reports solved and simply runs out of budget.
    return {
      normalized: [Math.min(1, (state.par / state.actions) ** 2)],
      raw: [state.actions],
      reason: `solved: the grid was completed in ${state.actions} action(s), par ${state.par}`,
      solved: true,
      par: state.par,
    };
  },

  /**
   * Budget truncation on an efficiency tier: unsolved. (The runner also ends
   * exhausted episodes itself; this covers direct calls and is required by
   * the Game shape.)
   *
   * @param {NonogramState} state
   * @returns {Outcome}
   */
  truncate(state) {
    return {
      normalized: [0],
      raw: null,
      reason: 'budget exhausted before the grid was completed',
      solved: false,
      par: state.par,
    };
  },
};

/**
 * The episode's action budget: the tier's maxActions.
 *
 * @param {NonogramState} state
 * @returns {number}
 */
function budgetOf(state) {
  const def = TIER_DEFS.find((candidate) => candidate.id === state.tierId);
  return def ? def.maxActions : state.rows * state.cols * 5;
}

/** @type {Game<NonogramState>} */
export default nonogram;
