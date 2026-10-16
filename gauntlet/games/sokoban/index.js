/**
 * Sokoban: the Gauntlet's long-horizon planning game. One seat, perfect
 * information. One wrong push can make a level unsolvable, and episodes are
 * efficiency-scored in moves against the solver-proven optimal move count
 * (`parKind: "optimal"`).
 *
 * Levels are generated per seed by reverse-play scrambling (see
 * `generator.js`) and proven solvable by the BFS solver (`solver.js`) before
 * they ship; the proven optimal move count is stored in the state as `par`.
 *
 * `undo` is a first-class action and counts toward the episode budget.
 * Pure JS (no `node:*`) — the browser overlay loads this module.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { deltasFor, renderXsb } from './solver.js';
import { generateLevel } from './generator.js';

/** @import { Game, InformationMode, Observation, Outcome, ParseResult, GameTag, TierSpec } from '../../core/types.js' */

/**
 * Par bands and generation parameters per tier, set from the measured par
 * distributions of 200 accepted levels per tier (see the PR for the
 * measurement script): medians land near 8–13 moves and the observed maximum
 * near 25, whatever the box count, because pulls drag boxes only a few
 * squares before clustering. Each band therefore starts above the previous
 * tier's median so trivial scrambles are rejected, rises in floor with tier
 * rank, and stays reachable: roughly half of scramble attempts land inside
 * each band. The tiers differ chiefly in box count and budget; maxActions =
 * 5 × parMax per the Gauntlet budget rule.
 *
 * @type {Record<string, { width: number, height: number, boxes: number, parMin: number, parMax: number, pullsMin: number, pullsMax: number, wallsMax: number }>}
 */
export const TIER_GENERATION = {
  'one-box': {
    width: 5,
    height: 5,
    boxes: 1,
    parMin: 4,
    parMax: 15,
    pullsMin: 6,
    pullsMax: 15,
    wallsMax: 1,
  },
  'two-box': {
    width: 7,
    height: 7,
    boxes: 2,
    parMin: 6,
    parMax: 30,
    pullsMin: 12,
    pullsMax: 30,
    wallsMax: 2,
  },
  'three-box': {
    width: 8,
    height: 8,
    boxes: 3,
    parMin: 10,
    parMax: 40,
    pullsMin: 20,
    pullsMax: 45,
    wallsMax: 3,
  },
  'four-box': {
    width: 9,
    height: 9,
    boxes: 4,
    parMin: 12,
    parMax: 45,
    pullsMin: 30,
    pullsMax: 60,
    wallsMax: 4,
  },
};

/**
 * Game state: plain JSON, so it survives a round trip unchanged. The static
 * level travels inside the state so every function is self-contained.
 *
 * @typedef {object} SokobanState
 * @property {number} width Board width including the wall border.
 * @property {number} height Board height including the wall border.
 * @property {number[]} walls Sorted wall square indices.
 * @property {number[]} goals Sorted goal square indices.
 * @property {number} player Player square index.
 * @property {number[]} boxes Sorted box square indices.
 * @property {number} par Solver-proven optimal move count for the episode.
 * @property {number} moves Valid actions taken so far, undos included.
 * @property {{ player: number, boxes: number[] }[]} history Undo stack of
 *   previous positions, most recent last.
 */

const ACTION_NAMES = ['down', 'left', 'right', 'undo', 'up'];

/**
 * @param {SokobanState} state
 * @returns {boolean} True when every box stands on a goal.
 */
function isSolved(state) {
  const goalSet = new Set(state.goals);
  return state.boxes.every((b) => goalSet.has(b));
}

/**
 * The sorted legal actions for the seat to act. Walking into a wall is
 * illegal; walking into a box is a push and legal when the square behind the
 * box is free. `undo` is legal exactly when there is something to undo.
 *
 * @param {SokobanState} state
 * @returns {string[]} Sorted canonical action strings.
 */
function computeLegalActions(state) {
  const d = deltasFor(state.width);
  const boxSet = new Set(state.boxes);
  const wallSet = new Set(state.walls);
  const size = state.width * state.height;
  /** @type {string[]} */
  const legal = [];
  for (const name of ['down', 'left', 'right', 'up']) {
    const delta = d[/** @type {'down' | 'left' | 'right' | 'up'} */ (name)];
    const target = state.player + delta;
    if (target < 0 || target >= size || wallSet.has(target)) continue;
    if (boxSet.has(target)) {
      const into = target + delta;
      if (into < 0 || into >= size || wallSet.has(into) || boxSet.has(into)) continue;
    }
    legal.push(name);
  }
  if (state.history.length > 0) legal.push('undo');
  return legal.sort();
}

/**
 * Apply a canonical action to a position (no validation beyond what apply
 * itself needs). Shared by `step`, the undo semantics and the baselines.
 *
 * @param {SokobanState} state
 * @param {string} action
 * @returns {SokobanState}
 */
export function applyAction(state, action) {
  if (action === 'undo') {
    const previous = state.history[state.history.length - 1];
    return {
      ...state,
      player: previous.player,
      boxes: [...previous.boxes],
      moves: state.moves + 1,
      history: state.history.slice(0, -1),
    };
  }
  const delta = deltasFor(state.width)[/** @type {'down' | 'left' | 'right' | 'up'} */ (action)];
  const target = state.player + delta;
  const boxSet = new Set(state.boxes);
  /** @type {number[]} */
  let boxes;
  let player = target;
  if (boxSet.has(target)) {
    const into = target + delta;
    boxes = state.boxes.filter((b) => b !== target);
    boxes.push(into);
    boxes.sort((a, b) => a - b);
  } else {
    boxes = [...state.boxes];
  }
  return {
    ...state,
    player,
    boxes,
    moves: state.moves + 1,
    history: [...state.history, { player: state.player, boxes: [...state.boxes] }],
  };
}

/**
 * Parse agent reply text into a canonical action. Documented alternates: an
 * optional verb (move, push, walk, go, step, pull) before the direction,
 * uppercase letters, and wrapping quotes or backticks.
 *
 * @param {SokobanState} _state Unused; parsing is state-free.
 * @param {string} text
 * @returns {ParseResult}
 */
function parseActionText(_state, text) {
  let s = String(text).trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('`') && s.endsWith('`')) ||
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.toLowerCase().replace(/^(move|push|walk|go|step|pull)\s+/, '');
  if (ACTION_NAMES.includes(s)) return { ok: true, action: s };
  return {
    ok: false,
    error:
      `cannot parse ${JSON.stringify(String(text))} as an action; ` +
      `use up, down, left, right or undo`,
  };
}

const RULES_TEXT = [
  'Classic Sokoban. You are the warehouse keeper (@; + when you stand on a goal) on a rectangular floor bordered by walls (#).',
  'Boxes are $ (* when a box sits on a goal); goals are .. You win by pushing every box onto a goal: a level is solved exactly when no box is off a goal.',
  'Actions: up, down, left, right move you one square. Walking into a box pushes it one square in the same direction if the square behind it is free; otherwise the move is illegal and consumes an action attempt.',
  'Boxes can never be pulled. Pushes are irreversible in practice: a box pushed into a corner, against a wall line without goals, or against another frozen box can never reach a goal again, which can make the level unsolvable. A pushed box may also block you in; if you have no legal action left, the episode ends unsolved.',
  'undo reverts your last action (undoes stack: repeated undos walk back through the whole game) and counts as an action like any other.',
  'Scoring is efficiency against par: par is the proven minimum number of actions for this exact level. Finishing in par actions scores highest; every extra action (walks, pushes, undos, and invalid attempts) lowers the score, and running out of the action budget scores zero.',
  'The board is drawn in standard Sokoban notation: # wall, @ you, + you on a goal, $ box, * box on goal, . goal, space floor.',
].join(' ');

/** @type {TierSpec[]} */
const TIERS = [
  {
    id: 'one-box',
    rank: 1,
    scoring: 'efficiency',
    maxActions: 5 * TIER_GENERATION['one-box'].parMax, // 75
    publicSeeds: 16,
    parKind: 'optimal',
    params: { ...TIER_GENERATION['one-box'] },
  },
  {
    id: 'two-box',
    rank: 2,
    scoring: 'efficiency',
    maxActions: 5 * TIER_GENERATION['two-box'].parMax, // 130
    publicSeeds: 25,
    parKind: 'optimal',
    params: { ...TIER_GENERATION['two-box'] },
  },
  {
    id: 'three-box',
    rank: 3,
    scoring: 'efficiency',
    maxActions: 5 * TIER_GENERATION['three-box'].parMax, // 220
    publicSeeds: 25,
    parKind: 'optimal',
    params: { ...TIER_GENERATION['three-box'] },
  },
  {
    id: 'four-box',
    rank: 4,
    scoring: 'efficiency',
    maxActions: 5 * TIER_GENERATION['four-box'].parMax, // 350
    publicSeeds: 25,
    parKind: 'optimal',
    params: { ...TIER_GENERATION['four-box'] },
  },
];

export const sokoban = {
  spec: {
    id: 'sokoban',
    version: '1.0.0',
    title: 'Sokoban',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {GameTag[]} */ (['planning', 'long-horizon']),
    benchmark: true,
    requires: [],
    rulesText: RULES_TEXT,
    tiers: TIERS,
  },

  /**
   * Generate the episode's level from the seed and prove its par.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {SokobanState}
   */
  reset(tier, seed) {
    const params = /** @type {typeof TIER_GENERATION['two-box']} */ (
      /** @type {*} */ (tier.params)
    );
    const generated = generateLevel(params, seed);
    return {
      width: generated.level.width,
      height: generated.level.height,
      walls: [...generated.level.walls],
      goals: [...generated.level.goals],
      player: generated.player,
      boxes: [...generated.boxes],
      par: generated.par,
      moves: 0,
      history: [],
    };
  },

  /**
   * Seat 0 acts until the level is solved or the player is deadlocked.
   *
   * @param {SokobanState} state
   * @returns {number | null}
   */
  toAct(state) {
    if (isSolved(state)) return null;
    if (computeLegalActions(state).length === 0) return null; // deadlocked
    return 0;
  },

  /**
   * @param {SokobanState} state
   * @param {number} _seat
   * @returns {Observation}
   */
  observe(state, _seat) {
    const board = renderXsb(
      { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
      state.player,
      state.boxes
    );
    const legal = computeLegalActions(state);
    const solved = isSolved(state);
    const status = solved
      ? `Solved in ${state.moves} actions (par ${state.par}).`
      : `Actions taken: ${state.moves} of a budget that ends the episode at 5 × par. Par for this level: ${state.par}.`;
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}): ${legal.join(', ')}`
        : 'Legal actions: none (game over).';
    return {
      text: ['Sokoban. You are seat 0.', board, status, legalText].join('\n'),
      data: { ...state },
    };
  },

  /**
   * @param {SokobanState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (seat !== 0) return [];
    if (isOver(state)) return [];
    return computeLegalActions(state);
  },

  /**
   * @param {SokobanState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (seat !== 0) return { ok: false, error: `it is not seat ${seat}'s turn` };
    if (this.toAct(state) === null) return { ok: false, error: 'the game is over' };
    const parsed = parseActionText(state, text);
    if (!parsed.ok) return parsed;
    if (!computeLegalActions(state).includes(parsed.action)) {
      if (parsed.action === 'undo') {
        return { ok: false, error: 'nothing to undo' };
      }
      return {
        ok: false,
        error: `${parsed.action} is blocked (a wall, or a box that cannot be pushed)`,
      };
    }
    return parsed;
  },

  /**
   * @param {SokobanState} state
   * @param {number} seat
   * @param {string} action
   * @returns {SokobanState}
   */
  step(state, seat, action) {
    if (seat !== 0) {
      throw new GauntletRuleError(`it is seat 0's turn, not seat ${seat}'s`);
    }
    if (isOver(state)) {
      throw new GauntletRuleError('the game is over');
    }
    if (typeof action !== 'string' || !computeLegalActions(state).includes(action)) {
      throw new GauntletRuleError(`illegal action ${JSON.stringify(action)}`);
    }
    return applyAction(state, action);
  },

  /**
   * Non-null exactly when `toAct` is null: solved episodes carry the
   * efficiency score of the valid actions taken (par / moves, squared, capped
   * at 1 — the authoritative episode score is recomputed by the scorer from
   * the trajectory, whose agentActions also counts invalid attempts);
   * deadlocked episodes are unsolved.
   *
   * @param {SokobanState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    const solved = isSolved(state);
    const deadlocked = !solved && computeLegalActions(state).length === 0;
    if (!solved && !deadlocked) return null;
    const efficiency = solved ? Math.min(1, (state.par / Math.max(state.moves, 1)) ** 2) : 0;
    return {
      normalized: [efficiency],
      // Per-seat game-native scores: [moves taken, proven par].
      raw: [state.moves, state.par],
      reason: solved
        ? `solved in ${state.moves} actions against par ${state.par}`
        : `unsolved: the player is deadlocked with ${offGoalCount(state)} box(es) off goal`,
      solved,
      par: state.par,
    };
  },

  /**
   * The Outcome when the agent's action budget runs out mid-game: unsolved,
   * zero score. (No tier scores by outcome, but the Game type requires
   * truncate; budget exhaustion on an efficiency tier is unsolved.)
   *
   * @param {SokobanState} state
   * @returns {Outcome}
   */
  truncate(state) {
    return {
      normalized: [0],
      raw: null,
      reason: `budget exhausted with ${offGoalCount(state)} box(es) off goal`,
      solved: false,
      par: state.par,
    };
  },
};

/**
 * @param {SokobanState} state
 * @returns {number}
 */
function offGoalCount(state) {
  const goalSet = new Set(state.goals);
  return state.boxes.filter((b) => !goalSet.has(b)).length;
}

/**
 * Whether the episode has ended: solved or the player deadlocked.
 *
 * @param {SokobanState} state
 * @returns {boolean}
 */
function isOver(state) {
  return isSolved(state) || computeLegalActions(state).length === 0;
}

/** @type {Game<SokobanState>} */
export default sokoban;
