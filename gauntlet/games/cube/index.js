/**
 * Rubik's Cube (3x3x3) for PlayKit Gauntlet. One seat, perfect information,
 * deterministic: the scramble and its proven-optimal par are pure functions of
 * (tier, seed).
 *
 * The agent sees the cube as an unfolded net of colour letters (W Y R O G B)
 * and replies with one face turn per action. Scoring is action efficiency
 * against the proven-optimal turn count (`parKind: "optimal"`): an episode's
 * efficiency score is `solved ? min(1, (par / agentActions)^2) : 0` — you
 * cannot beat the optimal line, so the cap is 1.0. Invalid replies burn
 * budget but are invisible to the score: the runner records them in
 * `trajectory.end.agentActions` (and its budget accounting), while
 * `outcome()` is computed from the game state alone and scores over valid
 * turns only. Nothing recomputes `normalized` from total attempts — the
 * scoring layer that would do that does not exist in this stack.
 *
 * Clockwise is the convention solvers and models get wrong, so it is pinned
 * in rulesText, restated in every observation, and fixed by hand-written net
 * fixtures in `cube.test.js`: a bare letter turns that face clockwise AS SEEN
 * LOOKING STRAIGHT AT THAT FACE from outside the cube.
 *
 * Tiers are bands of proven-optimal length (moves with no two turns of the
 * same face in a row, solved exactly by the meet-in-the-middle solver in
 * `solver.js`, accepted only inside the band):
 * - cube-5: optimal 4-5 turns.
 * - cube-7: optimal 6-7 turns.
 * - cube-9: optimal 8-9 turns. The task's original sketch allowed up to 10,
 *   but a proven-optimal-10 solve requires exhausting the full 5-ply forward
 *   ball (~575k states, ~1.7s per candidate) which leaves no headroom under
 *   the 2s-per-seed reset budget once rejection retries are counted, so the
 *   top band was capped at 9 (each candidate there solves in ~0.15s). This is
 *   the "adjust if generation is too slow, and say so" clause.
 * maxActions follows the ARC-AGI-3 5x budget rule: 5 x the tier's maximum
 * par (25 / 35 / 45).
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  CANONICAL_MOVES,
  FACES,
  SOLVED,
  applyMove,
  applySequence,
  isSolved,
  renderNet,
} from './cube.js';
import { buildDistanceTable, solveOptimal } from './solver.js';

/** @import { Game, InformationMode, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */

/**
 * Game state: plain JSON, so it survives a round trip unchanged.
 *
 * @typedef {object} CubeState
 * @property {string} facelets 54-character facelet string (see cube.js).
 * @property {number} par Proven-optimal turn count, computed at reset.
 * @property {number} maxActions The tier's static action budget.
 * @property {number} moveCount Valid turns made so far.
 */

/**
 * Parse result for one attempted turn, before legality (every one of the 18
 * canonical turns is legal while the cube is unsolved).
 *
 * @typedef {{ kind: 'ok', action: string }
 *   | { kind: 'sequence' }
 *   | { kind: 'lowercase' }
 *   | { kind: 'invalid' }} TurnParse
 */

/**
 * Accepted suffix spellings after the face letter: canonical plus the
 * documented alternates (Ui / U- for prime, U2' for the half turn).
 * @type {Record<string, string>}
 */
const SUFFIX_ACTIONS = {
  '': '',
  "'": "'",
  i: "'",
  '-': "'",
  2: '2',
  "2'": '2',
  '2i': '2',
  '2-': '2',
};

/**
 * Normalize an attempted turn. Tolerates surrounding quotes/backticks (the
 * runner usually strips one wrapping pair already) and whitespace, backtick
 * or quote characters anywhere inside; rejects lowercase face letters
 * (cubers write wide turns lowercase, which this game does not model) and
 * multi-turn sequences.
 *
 * @param {string} text
 * @returns {TurnParse}
 */
function normalizeTurn(text) {
  let s = String(text).trim();
  if (
    s.length >= 2 &&
    ((s[0] === '`' && s.endsWith('`')) ||
      (s[0] === '"' && s.endsWith('"')) ||
      (s[0] === "'" && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  // tolerate whitespace, backticks and quotes anywhere — but NOT the ASCII
  // apostrophe, which is the prime suffix
  s = s.replace(/[\s`"‘’]/g, '');

  if (s.length === 0) return { kind: 'invalid' };
  if (/^[urfdlb]/.test(s)) return { kind: 'lowercase' };
  const match = /^([URFDLB])(2)?(['i-])?$/.exec(s);
  if (match === null) {
    const faceLetters = s.match(/[URFDLB]/g) ?? [];
    if (faceLetters.length >= 2) return { kind: 'sequence' };
    return { kind: 'invalid' };
  }
  const suffix = (match[2] ?? '') + (match[3] ?? '');
  const action = match[1] + SUFFIX_ACTIONS[suffix];
  if (action === undefined) return { kind: 'invalid' };
  return { kind: 'ok', action };
}

/** Per-tier-and-seed memo of generated instances, so re-resets are free. */
const resetMemo = new Map();

/**
 * Clears the reset memo (exported for the reset-timing test).
 * @returns {void}
 */
export function clearResetMemo() {
  resetMemo.clear();
}

/**
 * Tier band parameters.
 * @typedef {{ bandMin: number, bandMax: number, walkLength: number }} CubeTierParams
 */

/**
 * Seeded rejection sampling: random walks from solved with no two turns of
 * the same face in a row, kept only when their proven-optimal length lands
 * inside the tier band. Deterministic in (tier, seed).
 *
 * @param {CubeTierParams} params
 * @param {string} seed
 * @returns {{ facelets: string, par: number }}
 */
function generateInstance(params, seed) {
  let rng = rngFromSeed(`${seed}/scramble`);
  for (let attempt = 0; attempt < 200; attempt++) {
    /** @type {string[]} */
    const walk = [];
    let lastFace = '';
    while (walk.length < params.walkLength) {
      const facePick = nextInt(rng, 0, FACES.length - 1);
      rng = facePick.state;
      const face = FACES[facePick.value];
      if (face === lastFace) continue;
      const suffixPick = nextInt(rng, 0, 2);
      rng = suffixPick.state;
      walk.push(face + ['', "'", '2'][suffixPick.value]);
      lastFace = face;
    }
    const candidate = applySequence(SOLVED, walk);
    const optimal = solveOptimal(candidate);
    if (optimal.length >= params.bandMin && optimal.length <= params.bandMax) {
      return { facelets: candidate, par: optimal.length };
    }
  }
  throw new Error(
    `cube reset: no scramble in band [${params.bandMin}, ${params.bandMax}] after 200 attempts (seed ${seed})`
  );
}

/**
 * @param {CubeState} state
 * @returns {boolean}
 */
function solved(state) {
  return isSolved(state.facelets);
}

const NOTATION_LINE =
  "Notation: a reply is exactly one face turn, one of U, U', U2, D, D', D2, " +
  "L, L', L2, R, R', R2, F, F', F2, B, B', B2. The letter names the FACE to turn " +
  '(U=up, D=down, L=left, R=right, F=front, B=back) and is not a colour letter. ' +
  'A bare letter (R) turns that face one quarter turn clockwise as seen looking ' +
  "straight at that face from outside the cube; the suffix ' is a quarter turn " +
  'counter-clockwise as seen the same way; the suffix 2 is a half turn.';

export const cube = {
  spec: {
    id: 'cube',
    version: '1.0.0',
    title: "Rubik's Cube",
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['spatial', 'planning']),
    benchmark: true,
    requires: [],
    rulesText: [
      "Rules: Rubik's Cube 3x3x3. The cube starts scrambled; turn faces until every facelet matches its face's centre colour. The six centre facelets never move and define each face's colour.",
      'Colours: W=up, G=right, R=front, O=back, B=left, Y=down.',
      'The observation shows the cube as an unfolded net: the up face on top, then the left, front, right and back faces in one band, then the down face. Each face is drawn as it looks when you look straight at that face from outside the cube (the back face is shown from behind the cube, the down face from below).',
      NOTATION_LINE,
      'Clockwise is ALWAYS judged looking directly at the turned face from outside the cube, so a D turn is clockwise seen from below and a B turn clockwise seen from behind.',
      "Accepted alternates: Ui or U- for U' (the i or - suffix means prime), U2' for U2, and surrounding quotes or backticks ('R', \"R'\", `R`) with extra internal whitespace (R 2) are tolerated.",
      'Lowercase face letters (r, u, f...) are rejected: in cube notation lowercase means a wide two-layer turn, which this game does not use.',
      "A sequence such as R U R' is rejected: one turn per reply.",
      'Scoring: efficiency against the proven-optimal (par) turn count for your scramble. Solving with exactly par turns scores 1.0; every extra turn multiplies the score by (par/turns)^2, capped at 1.0. Invalid replies consume action budget but do not count as turns when scoring: the score is computed over your valid turns only.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'cube-5',
        rank: 1,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 25,
        publicSeeds: 6,
        params: { bandMin: 4, bandMax: 5, walkLength: 5 },
      },
      {
        id: 'cube-7',
        rank: 2,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 35,
        publicSeeds: 6,
        params: { bandMin: 6, bandMax: 7, walkLength: 7 },
      },
      {
        id: 'cube-9',
        rank: 3,
        scoring: 'efficiency',
        parKind: 'optimal',
        maxActions: 45,
        publicSeeds: 6,
        params: { bandMin: 8, bandMax: 9, walkLength: 9 },
      },
    ]),
  },

  /**
   * Deterministic in (tier, seed): the scramble, and its par proven by the
   * meet-in-the-middle solver, come only from the seed.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {CubeState}
   */
  reset(tier, seed) {
    const key = `${tier.id}\n${seed}`;
    const memo = resetMemo.get(key);
    if (memo !== undefined) return memo;
    const params = /** @type {CubeTierParams} */ (tier.params);
    const instance = generateInstance(params, seed);
    /** @type {CubeState} */
    const state = {
      facelets: instance.facelets,
      par: instance.par,
      maxActions: tier.maxActions,
      moveCount: 0,
    };
    resetMemo.set(key, state);
    return state;
  },

  /**
   * @param {CubeState} state
   * @returns {number | null}
   */
  toAct(state) {
    return solved(state) ? null : 0;
  },

  /**
   * @param {CubeState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const header = `Rubik's Cube (3x3x3). You are seat ${seat}. Turn the faces until every facelet matches its face's centre colour.`;
    const colourLine =
      'Colour legend: W=up, G=right, R=front, O=back, B=left, Y=down. The centre facelets are fixed.';
    const netLine =
      'The net unfolds the cube: the up face on top, then left, front, right, back in one band, then the down face. Each face is drawn as it looks when you look straight at that face from outside the cube.';
    const budgetLine = `Turns used: ${state.moveCount} of ${state.maxActions}.`;
    const legalLine = `Legal actions (18, at most 64 so all are listed): ${CANONICAL_MOVES.join(', ')}`;
    return {
      text: [
        header,
        colourLine,
        netLine,
        NOTATION_LINE,
        renderNet(state.facelets),
        budgetLine,
        legalLine,
      ].join('\n'),
      data: {
        facelets: state.facelets,
        moveCount: state.moveCount,
        maxActions: state.maxActions,
        solved: solved(state),
        you: seat,
      },
    };
  },

  /**
   * @param {CubeState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (seat !== 0 || solved(state)) return [];
    return CANONICAL_MOVES;
  },

  /**
   * @param {CubeState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (seat !== 0) {
      return { ok: false, error: `the cube is single-seat; seat ${seat} has no turn` };
    }
    if (solved(state)) {
      return { ok: false, error: 'the cube is already solved' };
    }
    const parsed = normalizeTurn(text);
    switch (parsed.kind) {
      case 'sequence':
        return {
          ok: false,
          error: "one turn per reply: reply with a single face turn such as R, R' or R2",
        };
      case 'lowercase':
        return {
          ok: false,
          error: `lowercase face letters are not accepted (lowercase means a wide two-layer turn in cube notation); use uppercase, e.g. ${JSON.stringify(String(text).trim().toUpperCase())}`,
        };
      case 'invalid':
        return {
          ok: false,
          error: `cannot parse ${JSON.stringify(String(text))} as a face turn; use one of U, U', U2, D, D', D2, L, L', L2, R, R', R2, F, F', F2, B, B', B2 (alternates Ui, U- for prime and U2' for the half turn are accepted)`,
        };
      default:
        return { ok: true, action: parsed.action };
    }
  },

  /**
   * @param {CubeState} state
   * @param {number} seat
   * @param {string} action
   * @returns {CubeState}
   */
  step(state, seat, action) {
    if (seat !== 0) {
      throw new GauntletRuleError(`the cube is single-seat; seat ${seat} has no turn`);
    }
    if (solved(state)) {
      throw new GauntletRuleError('the cube is already solved');
    }
    if (typeof action !== 'string' || !CANONICAL_MOVES.includes(action)) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    return {
      ...state,
      facelets: applyMove(state.facelets, action),
      moveCount: state.moveCount + 1,
    };
  },

  /**
   * @param {CubeState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (!solved(state)) return null;
    const score = Math.min(1, (state.par / Math.max(1, state.moveCount)) ** 2);
    return {
      normalized: [score],
      raw: [{ turns: state.moveCount, par: state.par }],
      reason: `solved in ${state.moveCount} turns (proven optimal par ${state.par})`,
      solved: true,
      par: state.par,
    };
  },

  /**
   * Budget exhaustion on an efficiency tier: unsolved, zero score. (The tier
   * scores by efficiency, so the runner supplies this too; provided for
   * completeness.)
   *
   * @param {CubeState} state
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

// Warmed lazily on first reset/solve; touched here so the reset-timing test
// can exclude the once-per-process table build explicitly.
void buildDistanceTable;

/** @type {Game<CubeState>} */
export default cube;
