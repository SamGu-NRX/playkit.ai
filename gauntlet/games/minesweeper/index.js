/**
 * Minesweeper for the PlayKit Gauntlet: a hidden-information deduction game
 * in which every scored board can be cleared by logic alone, so the score
 * measures reasoning rather than luck.
 *
 * Layouts are drawn from the episode RNG until one is found that the
 * deduction solver (`logicalPass` — single-cell and subset rules, never
 * probabilities) can clear from the seeded opening without a single guess;
 * the number of attempts is recorded in the state. Tiers cover the classic
 * beginner / intermediate / expert boards plus a torus variant whose edges
 * wrap — a rule change models are unlikely to have practiced.
 *
 * Outcome scoring: normalized = revealed safe cells / total safe cells, and
 * exactly 1 on a win. Hitting a mine ends the episode at the fraction
 * reached. The action budget is safe cells + mines + 20, so a perfect game
 * (every reveal cascades at worst one cell, plus optional flags) always fits.
 *
 * No `node:*` imports; every random choice comes from the core RNG seeded by
 * the episode seed.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { streamFromSeed } from '../../core/rng.js';
import {
  FLAG,
  HIDDEN,
  logicalPass,
  neighborLists,
} from './solver.js';

/** @import { Game, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */

/**
 * @typedef {object} MinesweeperTierParams
 * @property {number} rows
 * @property {number} cols
 * @property {number} mines
 * @property {boolean} wrap True for the torus tier: edges wrap around.
 */

/**
 * Game state: plain JSON, so it survives a round trip unchanged. The mine
 * layout (`mines`, `counts`) and `attempts` are hidden information —
 * `observe` never exposes them.
 *
 * @typedef {object} MinesweeperState
 * @property {number} rows
 * @property {number} cols
 * @property {boolean} wrap
 * @property {number} minesTotal
 * @property {number[]} mines Sorted mine cell indices.
 * @property {number[]} counts Adjacent-mine counts per cell (hidden).
 * @property {boolean[]} revealed
 * @property {boolean[]} flagged
 * @property {'playing' | 'won' | 'lost'} status
 * @property {number | null} mineAt Index of the mine that was hit, on a loss.
 * @property {number} attempts Layout attempts drawn before this board was
 *   accepted by the no-guess generator (1 for a first-try board).
 */

/** Tier parameter triples: [rows, cols, mines]. @type {Record<string, [number, number, number]>} */
const TIER_BOARDS = {
  beginner: [9, 9, 10],
  intermediate: [16, 16, 40],
  expert: [16, 30, 99],
  // Torus density is calibrated for uniform random play: at 40 mines the
  // edge-free wrap (every cell has 8 neighbours, cascades flood wider) made
  // the torus EASIER for uniform play than the intermediate (random 0.412 vs
  // 0.354) and far easier than expert (0.135), which the calibration
  // b-monotonic check correctly flags. At 70 mines (27.3% density) random
  // play drops to ~0.19 — below intermediate, above expert — while seeded
  // no-guess generation stays cheap (mean ~50 rejection attempts; at 80+
  // mines acceptance collapses, 4k+ attempts mean).
  torus: [16, 16, 70],
};

/** @param {MinesweeperState} state @returns {number} */
function totalSafe(state) {
  return state.rows * state.cols - state.minesTotal;
}

/** @param {MinesweeperState} state @returns {number} */
function revealedSafe(state) {
  let n = 0;
  for (let i = 0; i < state.revealed.length; i++) {
    if (state.revealed[i] && !state.mines.includes(i)) n++;
  }
  return n;
}

/**
 * Flood-reveal from `start` over zero cells and their boundary, into
 * `revealed` (which is mutated — callers pass a fresh array). Never reveals
 * a mine: zero cells have no mined neighbours, and flooding stops at
 * numbered boundary cells.
 *
 * @param {number[]} counts
 * @param {number[][]} neighbors
 * @param {number} start
 * @param {boolean[]} revealed
 * @returns {void}
 */
function floodReveal(counts, neighbors, start, revealed) {
  const stack = [start];
  while (stack.length > 0) {
    const i = /** @type {number} */ (stack.pop());
    if (revealed[i]) continue;
    revealed[i] = true;
    if (counts[i] === 0) {
      for (const j of neighbors[i]) {
        if (!revealed[j]) stack.push(j);
      }
    }
  }
}

/**
 * The visible view: numbers where revealed, FLAG where flagged, HIDDEN
 * elsewhere. Contains no hidden information.
 *
 * @param {MinesweeperState} state
 * @returns {number[]}
 */
function viewOf(state) {
  const view = new Array(state.revealed.length).fill(HIDDEN);
  for (let i = 0; i < view.length; i++) {
    if (state.revealed[i]) view[i] = state.counts[i];
    else if (state.flagged[i]) view[i] = FLAG;
  }
  return view;
}

/**
 * Canonical action strings, sorted. `reveal r c` on every hidden unflagged
 * cell, `flag r c` on the same set, `unflag r c` on flagged cells, and
 * `chord r c` on revealed numbered cells whose flags exactly match their
 * number and still have unrevealed, unflagged neighbours (the only chords
 * that can change the board).
 *
 * @param {MinesweeperState} state
 * @returns {string[]}
 */
function legalActionList(state) {
  if (state.status !== 'playing') return [];
  const neighbors = neighborLists(state.rows, state.cols, state.wrap);
  /** @type {string[]} */
  const actions = [];
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const i = r * state.cols + c;
      if (!state.revealed[i] && !state.flagged[i]) {
        actions.push(`reveal ${r} ${c}`);
        actions.push(`flag ${r} ${c}`);
      } else if (state.flagged[i]) {
        actions.push(`unflag ${r} ${c}`);
      } else if (state.counts[i] > 0) {
        let flagsAround = 0;
        let hiddenAround = 0;
        for (const j of neighbors[i]) {
          if (state.flagged[j]) flagsAround++;
          else if (!state.revealed[j]) hiddenAround++;
        }
        if (flagsAround === state.counts[i] && hiddenAround > 0) {
          actions.push(`chord ${r} ${c}`);
        }
      }
    }
  }
  return actions.sort();
}

/**
 * Render the visible grid with row and column indices. `.` is hidden, `F` is
 * flagged, a digit is a revealed cell's mine count.
 *
 * @param {MinesweeperState} state
 * @returns {string}
 */
function renderGrid(state) {
  const view = viewOf(state);
  const colWidth = String(state.cols - 1).length;
  const rowWidth = String(state.rows - 1).length;
  /** @type {string[]} */
  const lines = [];
  // Column header: a tens line above the units line whenever columns reach
  // double digits, so a 30-wide board stays readable.
  if (colWidth > 1) {
    let tens = '';
    let units = '';
    for (let c = 0; c < state.cols; c++) {
      const label = String(c).padStart(colWidth, ' ');
      tens += `${label[0]} `;
      units += `${label[colWidth - 1]} `;
    }
    lines.push(`${' '.repeat(rowWidth)} | ${tens}`);
    lines.push(`${' '.repeat(rowWidth)} | ${units}`);
  } else {
    let units = '';
    for (let c = 0; c < state.cols; c++) units += `${c} `;
    lines.push(`${' '.repeat(rowWidth)} | ${units}`);
  }
  lines.push(`${'-'.repeat(rowWidth)} + ${'-'.repeat(state.cols * (colWidth + 1) - 1)}`);
  for (let r = 0; r < state.rows; r++) {
    /** @type {string[]} */
    const cells = [];
    for (let c = 0; c < state.cols; c++) {
      const v = view[r * state.cols + c];
      const glyph = v === HIDDEN ? '.' : v === FLAG ? 'F' : String(v);
      cells.push(colWidth > 1 ? glyph.padStart(colWidth, ' ') : glyph);
    }
    lines.push(`${String(r).padStart(rowWidth, ' ')} | ${cells.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * Draw layouts from the episode RNG until one is clearable by pure logic
 * (single-cell and subset deduction — never probabilities) from a seeded
 * zero-cell opening. Uniform over mine placements; the acceptance test is
 * the only filter, so the accepted layout is a uniform draw from the
 * no-guess layouts reachable through this procedure.
 *
 * @param {MinesweeperTierParams} params
 * @param {string} seed
 * @returns {{ mines: number[], counts: number[], revealed: boolean[], attempts: number }}
 */
function generateNoGuessBoard(params, seed) {
  const { rows, cols, mines: minesTotal, wrap } = params;
  const cells = rows * cols;
  const neighbors = neighborLists(rows, cols, wrap);
  const stream = streamFromSeed(`${seed}/layout`);
  let attempts = 0;
  for (;;) {
    attempts++;
    const order = stream.shuffle(
      Array.from({ length: cells }, (_, i) => i)
    );
    const mineSet = new Set(order.slice(0, minesTotal));
    /** @type {number[]} */
    const counts = new Array(cells);
    /** @type {number[]} */
    const zeros = [];
    for (let i = 0; i < cells; i++) {
      let count = 0;
      for (const j of neighbors[i]) if (mineSet.has(j)) count++;
      counts[i] = count;
      if (count === 0 && !mineSet.has(i)) zeros.push(i);
    }
    if (zeros.length === 0) continue;
    const opening = zeros[stream.nextInt(0, zeros.length - 1)];
    /** @type {boolean[]} */
    const revealed = new Array(cells).fill(false);
    floodReveal(counts, neighbors, opening, revealed);
    if (logicalClears(params, mineSet, counts, revealed)) {
      return {
        mines: [...mineSet].sort((a, b) => a - b),
        counts,
        revealed,
        attempts,
      };
    }
  }
}

/**
 * The no-guess acceptance test: play the board with `logicalPass` only —
 * reveal proven-safe cells (with flood), note proven mines as flags — until
 * deduction stalls. True when the board is fully revealed, i.e. clearable
 * with no guess at all.
 *
 * @param {MinesweeperTierParams} params
 * @param {Set<number>} mineSet
 * @param {number[]} counts
 * @param {boolean[]} initiallyRevealed
 * @returns {boolean}
 */
function logicalClears(params, mineSet, counts, initiallyRevealed) {
  const { rows, cols, mines: minesTotal, wrap } = params;
  const neighbors = neighborLists(rows, cols, wrap);
  const view = new Array(rows * cols).fill(HIDDEN);
  for (let i = 0; i < view.length; i++) {
    if (initiallyRevealed[i]) view[i] = counts[i];
  }
  const safeTotal = rows * cols - minesTotal;
  for (;;) {
    const { safe, mines } = logicalPass(view, neighbors, minesTotal);
    if (safe.length === 0 && mines.length === 0) break;
    for (const m of mines) view[m] = FLAG;
    for (const s of safe) {
      if (view[s] !== HIDDEN) continue;
      // Flood into the view directly: the view is the authoritative
      // revealed set of the simulated playthrough.
      const stack = [s];
      while (stack.length > 0) {
        const i = /** @type {number} */ (stack.pop());
        if (view[i] !== HIDDEN) continue;
        view[i] = counts[i];
        if (counts[i] === 0) {
          for (const j of neighbors[i]) if (view[j] === HIDDEN) stack.push(j);
        }
      }
    }
  }
  let revealedCount = 0;
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== HIDDEN && view[i] !== FLAG) revealedCount++;
  }
  return revealedCount === safeTotal;
}

/**
 * Apply a reveal to a fresh state (pure): mine hit → lost; otherwise flood
 * and check the win.
 *
 * @param {MinesweeperState} state
 * @param {number} index
 * @returns {MinesweeperState}
 */
function applyReveal(state, index) {
  const neighbors = neighborLists(state.rows, state.cols, state.wrap);
  const mineSet = new Set(state.mines);
  const revealed = state.revealed.slice();
  if (mineSet.has(index)) {
    return { ...state, revealed, status: 'lost', mineAt: index };
  }
  floodReveal(state.counts, neighbors, index, revealed);
  const next = { ...state, revealed, status: state.status, mineAt: null };
  if (revealedSafe(next) === totalSafe(state)) {
    return { ...next, status: 'won' };
  }
  return next;
}

const ACTION_RE =
  /^(reveal|flag|unflag|chord)\s+(\d+)\s+(\d+)$/;

/**
 * @param {MinesweeperState} state
 * @param {string} text
 * @returns {ParseResult}
 */
function parseCanonical(state, text) {
  const match = ACTION_RE.exec(text);
  if (!match) {
    return {
      ok: false,
      error: `cannot parse ${JSON.stringify(text)}; the action grammar is "reveal <row> <column>", "flag <row> <column>", "unflag <row> <column>" or "chord <row> <column>" with 0-based indices`,
    };
  }
  const verb = match[1];
  const r = Number(match[2]);
  const c = Number(match[3]);
  if (r >= state.rows || c >= state.cols) {
    return {
      ok: false,
      error: `cell (${r}, ${c}) is outside the ${state.rows}x${state.cols} grid (0-based indices)`,
    };
  }
  const i = r * state.cols + c;
  if (verb === 'unflag') {
    if (!state.flagged[i]) {
      return { ok: false, error: `cell (${r}, ${c}) is not flagged, so unflag would change nothing` };
    }
    return { ok: true, action: `unflag ${r} ${c}` };
  }
  if (verb === 'chord') {
    // A chord is only a chord target when the cell is a revealed number
    // whose flags exactly match its count and something is left to uncover
    // — the same condition legalActions uses to list it.
    if (!state.revealed[i]) {
      return { ok: false, error: `cell (${r}, ${c}) is not a chord target: only already-revealed numbered cells can be chorded` };
    }
    const neighbors = neighborLists(state.rows, state.cols, state.wrap);
    let flagsAround = 0;
    let hiddenAround = 0;
    for (const j of neighbors[i]) {
      if (state.flagged[j]) flagsAround++;
      else if (!state.revealed[j]) hiddenAround++;
    }
    if (flagsAround !== state.counts[i] || hiddenAround === 0) {
      return {
        ok: false,
        error: `cell (${r}, ${c}) is not a chord target: a chord needs the cell revealed with exactly ${state.counts[i]} surrounding flag(s) and at least one unflagged hidden neighbour`,
      };
    }
    return { ok: true, action: `chord ${r} ${c}` };
  }
  if (state.revealed[i]) {
    return {
      ok: false,
      error: `cell (${r}, ${c}) is already revealed; ${verb} would change nothing`,
    };
  }
  if (state.flagged[i]) {
    if (verb === 'flag') {
      return { ok: false, error: `cell (${r}, ${c}) is already flagged` };
    }
    return {
      ok: false,
      error: `cell (${r}, ${c}) is flagged; unflag it before ${verb === 'chord' ? 'chording it as a neighbour' : 'revealing it'}`,
    };
  }
  return { ok: true, action: `${verb} ${r} ${c}` };
}

/**
 * Build a state from an explicit mine layout — the deterministic constructor
 * used by tests (and available to harnesses that want hand-built boards).
 * `opening` flood-reveals a starting cell like a real episode.
 *
 * @param {{ rows: number, cols: number, mines: number, wrap: boolean }} params
 * @param {number[]} mineIndices Sorted mine cell indices.
 * @param {number} [opening] Cell to flood-reveal as the opening.
 * @returns {MinesweeperState}
 */
export function createBoard(params, mineIndices, opening) {
  const { rows, cols, mines: minesTotal, wrap } = params;
  const cells = rows * cols;
  const neighbors = neighborLists(rows, cols, wrap);
  const mineSet = new Set(mineIndices);
  const counts = new Array(cells);
  for (let i = 0; i < cells; i++) {
    let count = 0;
    for (const j of neighbors[i]) if (mineSet.has(j)) count++;
    counts[i] = count;
  }
  /** @type {boolean[]} */
  const revealed = new Array(cells).fill(false);
  if (opening !== undefined) floodReveal(counts, neighbors, opening, revealed);
  return {
    rows,
    cols,
    wrap,
    minesTotal,
    mines: [...mineSet].sort((a, b) => a - b),
    counts,
    revealed,
    flagged: new Array(cells).fill(false),
    status: 'playing',
    mineAt: null,
    attempts: 0,
  };
}

/**
 * The Minesweeper game.
 *
 * @type {Game<MinesweeperState>}
 */
export const game = {
  spec: {
    id: 'minesweeper',
    version: '1.2.0',
    title: 'Minesweeper',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('hidden'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['deduction', 'spatial']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Minesweeper on a grid of cells; some cells hide mines, everything else shows how many of its (up to 8) neighbouring cells hold mines.',
      'Cells are addressed 0-based: "reveal 3 4" means row 3, column 4 (rows count down from 0, columns right from 0).',
      'Actions: "reveal <row> <column>" uncovers a hidden cell — uncovering a mine ends the episode immediately with the fraction of safe cells revealed so far as your score, while uncovering a mine-free cell with zero neighbouring mines also uncovers all connected zero-count cells and their boundary (a cascade, counted as one action).',
      '"flag <row> <column>" / "unflag <row> <column>" mark or clear a suspected mine; flags are never graded and can always be removed.',
      '"chord <row> <column>" on an already-revealed numbered cell uncovers all of its unflagged hidden neighbours at once, but only when exactly that many flags already surround the cell; if a flag is wrong the chord uncovers a mine and loses.',
      'You win (score 1) by uncovering every mine-free cell; the mine layout per episode is guaranteed solvable by pure logic from the opening reveal already shown — no guessing is ever required.',
      'This torus variant wraps: the grid has no edges — row 0 neighbours row N-1 and column 0 neighbours column M-1 (diagonally too), so a cell at any position always has 8 neighbours; corner and edge reasoning must account for the wrap.',
      'Documented alternates: "open" or "dig" for reveal, "mark" for flag, surrounding quotes or backticks, and extra whitespace are all accepted.',
      'Invalid actions consume an attempt from the budget without changing the board.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ (
      ([
        ['beginner', 1],
        ['intermediate', 2],
        // Torus slots between intermediate and expert: for uniform play the
        // 70-mine wrap board is harder than the 40-mine intermediate but
        // easier than the 99-mine expert, and re-ranking is one of the two
        // remedies the calibration b-monotonic check itself proposes.
        ['torus', 3],
        ['expert', 4],
      ]).map(([id, rank]) => {
        const [rows, cols, mines] = TIER_BOARDS[/** @type {string} */ (id)];
        const wrap = id === 'torus';
        return {
          id: /** @type {string} */ (id),
          rank: /** @type {number} */ (rank),
          scoring: /** @type {'outcome'} */ ('outcome'),
          maxActions: rows * cols + 20,
          publicSeeds: 25,
          params: /** @type {MinesweeperTierParams} */ ({ rows, cols, mines, wrap }),
        };
      })
    ),
  },

  /**
   * Deterministic in (tier, seed): draws no-guess layouts from the seeded
   * RNG until one clears by pure logic from its opening. Memoized per
   * (tier, seed) because generation can take many attempts; callers still
   * get a fresh deep copy, and step never mutates state.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {MinesweeperState}
   */
  reset(tier, seed) {
    const params = /** @type {MinesweeperTierParams} */ (tier.params);
    const key = `${tier.id}/${seed}`;
    let cached = /** @type {MinesweeperState | undefined} */ (GENERATION_CACHE.get(key));
    if (!cached) {
      const board = generateNoGuessBoard(params, seed);
      cached = {
        rows: params.rows,
        cols: params.cols,
        wrap: params.wrap,
        minesTotal: params.mines,
        mines: board.mines,
        counts: board.counts,
        revealed: board.revealed,
        flagged: new Array(params.rows * params.cols).fill(false),
        status: 'playing',
        mineAt: null,
        attempts: board.attempts,
      };
      GENERATION_CACHE.set(key, cached);
    }
    // A fresh deep copy per call: step() must never share structure between
    // states, and the cache keeps generation's cost to one run per seed.
    return JSON.parse(JSON.stringify(cached));
  },

  /**
   * @param {MinesweeperState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * The observation never touches hidden information: the grid shows only
   * revealed counts and flags, and the tallies are all public numbers.
   * Two states with identical revealed cells (and therefore identical
   * revealed counts) and different mine layouts observe identically.
   *
   * @param {MinesweeperState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    void seat;
    const legal = legalActionList(state);
    const revealed = revealedSafe(state);
    const safe = totalSafe(state);
    const flags = state.flagged.filter(Boolean).length;
    const view = viewOf(state);
    const header =
      `Minesweeper: ${state.rows} rows x ${state.cols} cols, ${state.minesTotal} mines` +
      `${state.wrap ? ', torus board (edges wrap around: row 0 neighbours row ' +
        (state.rows - 1) + ', column 0 neighbours column ' + (state.cols - 1) + ')' : ''}.`;
    const legend = 'Grid: "." hidden, "F" flagged, digit = revealed cell showing its adjacent mine count (0-based row and column indices).';
    const status =
      state.status === 'playing'
        ? `Playing: ${revealed} of ${safe} safe cells revealed, ${state.minesTotal - flags} mines unaccounted for.`
        : state.status === 'won'
          ? `Game over: all ${safe} safe cells revealed — win.`
          : `Game over: mine hit at row ${Math.floor((/** @type {number} */ (state.mineAt)) / state.cols)}, column ${(/** @type {number} */ (state.mineAt)) % state.cols}.`;
    const legalText =
      state.status !== 'playing'
        ? 'Legal actions: none (game over).'
        : legal.length > 0 && legal.length <= 64
          ? `Legal actions: ${legal.join(', ')}.`
          : `Legal actions: ${legal.length} available — too many to list. Grammar: "reveal <row> <column>", "flag <row> <column>", "unflag <row> <column>", "chord <row> <column>" (0-based).`;
    return {
      text: [header, legend, renderGrid(state), status, legalText].join('\n'),
      data: {
        rows: state.rows,
        cols: state.cols,
        wrap: state.wrap,
        minesTotal: state.minesTotal,
        minesRemaining: state.minesTotal - flags,
        revealedSafe: revealed,
        totalSafe: safe,
        status: state.status,
        view,
      },
    };
  },

  /**
   * @param {MinesweeperState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    void seat;
    return legalActionList(state);
  },

  /**
   * @param {MinesweeperState} state
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
    // Documented alternates: "open"/"dig" for reveal, "mark" for flag.
    s = s.replace(/^(open|dig)\s+/, 'reveal ').replace(/^mark\s+/, 'flag ');
    s = s.replace(/\s+/g, ' ');
    return parseCanonical(state, s);
  },

  /**
   * Pure: applies the action to a fresh copy and never mutates its input.
   *
   * @param {MinesweeperState} state
   * @param {number} seat
   * @param {string} action
   * @returns {MinesweeperState}
   */
  step(state, seat, action) {
    void seat;
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    const match = ACTION_RE.exec(String(action));
    if (!match) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const verb = match[1];
    const r = Number(match[2]);
    const c = Number(match[3]);
    if (r >= state.rows || c >= state.cols) {
      throw new GauntletRuleError(`cell (${r}, ${c}) is outside the grid`);
    }
    const i = r * state.cols + c;
    const parsed = parseCanonical(state, `${verb} ${r} ${c}`);
    if (!parsed.ok) {
      throw new GauntletRuleError(parsed.error);
    }

    if (verb === 'flag') {
      const flagged = state.flagged.slice();
      flagged[i] = true;
      return { ...state, flagged };
    }
    if (verb === 'unflag') {
      const flagged = state.flagged.slice();
      flagged[i] = false;
      return { ...state, flagged };
    }
    if (verb === 'reveal') {
      return applyReveal(state, i);
    }
    // chord: reveal every unflagged hidden neighbour; any mine among them
    // loses (the canonical parse already checked the flag count matches).
    const neighbors = neighborLists(state.rows, state.cols, state.wrap);
    const mineSet = new Set(state.mines);
    const revealed = state.revealed.slice();
    for (const j of neighbors[i]) {
      if (!state.revealed[j] && !state.flagged[j] && mineSet.has(j)) {
        return { ...state, revealed, status: 'lost', mineAt: j };
      }
    }
    /** @type {MinesweeperState} */
    let next = { ...state, revealed, mineAt: null };
    for (const j of neighbors[i]) {
      if (!next.revealed[j] && !next.flagged[j]) {
        next = applyReveal(next, j);
        if (next.status !== 'playing') break;
      }
    }
    return next;
  },

  /**
   * @param {MinesweeperState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    return /** @type {Outcome} */ (finishOutcome(state, state.status));
  },

  /**
   * Budget truncation on this outcome tier scores the fraction of safe
   * cells revealed so far — the same partial credit a mine hit would score.
   *
   * @param {MinesweeperState} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    return finishOutcome(state, 'truncated');
  },
};

/**
 * Generation cache: one no-guess generation per (tier, seed) per process.
 * `reset` still returns a fresh deep copy per call, so callers never share
 * structure and the pure-function contract holds.
 *
 * @type {Map<string, MinesweeperState>}
 */
const GENERATION_CACHE = new Map();

/**
 * Shared outcome constructor for the three non-playing endings.
 *
 * @param {MinesweeperState} state
 * @param {'won' | 'lost' | 'truncated'} ending
 * @returns {Outcome}
 */
function finishOutcome(state, ending) {
  const safe = totalSafe(state);
  const revealed = revealedSafe(state);
  const fraction = safe > 0 ? revealed / safe : 1;
  if (ending === 'won' || revealed === safe) {
    return {
      normalized: [1],
      raw: [revealed],
      reason: `all ${safe} safe cells revealed — win`,
    };
  }
  if (ending === 'truncated') {
    return {
      normalized: [fraction],
      raw: [revealed],
      reason: `truncated: action budget exhausted with ${revealed} of ${safe} safe cells revealed`,
    };
  }
  const mineAt = /** @type {number} */ (state.mineAt);
  return {
    normalized: [fraction],
    raw: [revealed],
    reason: `mine revealed at row ${Math.floor(mineAt / state.cols)}, column ${mineAt % state.cols} — episode ends with ${revealed} of ${safe} safe cells revealed`,
  };
}

export default game;
