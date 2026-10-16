/**
 * Connect Four: a Gauntlet game. Two seats, perfect information, an engine
 * ladder plus a tier of forced-win positions the agent must convert, outcome
 * scored 1 / 0.5 / 0. Columns are 1-based (1 = leftmost, 7 = rightmost); the
 * choice is stated in rulesText and in every observation.
 *
 * - The depth-2 rung `ladder-0` sits between the random `ladder-1` and the
 *   depth-4 `ladder-2`: a shallow search punishes pure luck (it takes wins
 *   and blocks losses) without depth-4 tactics, so weak-but-real play
 *   separates from luck.
 * - Ladder tiers open with 0 to 4 seeded random plies that never hand the
 *   mover an immediate win or give the opponent one, so the agent never steps
 *   into a lost-on-the-spot position.
 * - The forced-win tier generates, per seed, positions from seeded random
 *   play that the exact solver proves are a win for the agent's side within
 *   17 to 21 plies, against the strongest engine opponent (exact play at
 *   every depth). Generation makes two passes of 240 attempts per seed; the
 *   retry pass re-rolls positions within the same band and never widens it.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { fnv1a64 } from '../../core/canonical.js';
import { nextInt, rngFromSeed, streamFromSeed } from '../../core/rng.js';

import {
  COLUMNS,
  HEIGHT,
  WIDTH,
  applyMove,
  emptyState,
  legalCols,
} from './rules.js';
import { chooseExactMove, chooseMove, immediateWinCols, solveExact, WIN_SCORE } from './engine.js';

/** @import { Agent, Game, InformationMode, Observation, Outcome, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */
/** @import { Connect4State } from './rules.js' */

const MARKS = ['X', 'O'];

/** Positions with this many discs or more are solved exactly. */
const EXACT_MIN_DISCS = 30;

/** Forced-win tier: accepted win distances, in plies. The retry pass re-rolls
 *  attempts within the same band — the tier never emits a win shallower than
 *  MIN_WIN_PLIES, so these constants are the tier's advertised contract. */
export const MIN_WIN_PLIES = 17;
export const MAX_WIN_PLIES = 21;

/**
 * The agent's seat alternates with the seed, so it plays both colors across
 * the public seed set.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {number}
 */
function seatForSeed(tier, seed) {
  return Number(BigInt('0x' + fnv1a64(`${tier.id}/${seed}`)) % 2n);
}

/**
 * 0 to 4 seeded random plies that do not lose immediately: each opening ply
 * must neither win the game on the spot (that would end it before the agent
 * plays) nor give the opponent an immediate winning reply. If no safe ply
 * exists, the opening stops early.
 *
 * @param {Connect4State} state
 * @param {string} seed
 * @returns {Connect4State}
 */
function withSeededOpening(state, seed) {
  const stream = rngFromSeed(`${seed}/opening`);
  const plies = nextInt(stream, 0, 4);
  let current = state;
  for (let i = 0; i < plies.value; i++) {
    if (current.status !== 'playing') break;
    const safe = legalCols(current).filter((col) => {
      const next = applyMove(current, current.toMove, col);
      return next.status === 'playing' && immediateWinCols(next).length === 0;
    });
    if (safe.length === 0) break;
    const pick = nextInt(plies.state, 0, safe.length - 1);
    current = applyMove(current, current.toMove, safe[pick.value]);
    plies.state = pick.state;
  }
  return { ...current, openingPlies: current.discs };
}

/**
 * Generate the forced-win tier's starting position: random seeded play until
 * the side to move is the agent and the exact solver proves a win for the
 * mover within [MIN_WIN_PLIES, MAX_WIN_PLIES] plies. Deterministic per seed.
 *
 * @param {number} agentSeat
 * @param {string} seed
 * @returns {Connect4State}
 */
function generateForcedWinPosition(agentSeat, seed) {
  for (let pass = 0; pass < 2; pass++) {
    // Both passes accept the same band; pass 1 only re-rolls the attempts
    // (different RNG streams), so no seed can receive a win outside the
    // advertised [MIN_WIN_PLIES, MAX_WIN_PLIES].
    const [lo, hi] = [MIN_WIN_PLIES, MAX_WIN_PLIES];
    for (let k = 0; k < 240; k++) {
      // Shallower boards keep forced wins long enough to land in the band;
      // deeper random play either ends early or leaves only win-in-1 shorts.
      const targetDiscs = 18 + (k % 9); // 18..26 discs placed
      let current = emptyState(agentSeat);
      let stream = rngFromSeed(`${seed}/generate/${pass}/${k}`);
      while (current.status === 'playing' && current.discs < targetDiscs) {
        const cols = legalCols(current);
        const pick = nextInt(stream, 0, cols.length - 1);
        current = applyMove(current, current.toMove, cols[pick.value]);
        stream = pick.state;
      }
      if (current.status !== 'playing') continue;
      if (current.toMove !== agentSeat) continue;
      // The mover taking a win-in-1 is below the band; skip before solving.
      if (immediateWinCols(current).length > 0) continue;
      const value = solveExact(current, { horizon: MAX_WIN_PLIES });
      if (value.verdict === 'win' && value.plies !== null && value.plies >= lo && value.plies <= hi) {
        return { ...current, forcedWinPlies: value.plies };
      }
    }
  }
  throw new Error(
    `forced-win generation exhausted all attempts for seed ${JSON.stringify(seed)}`
  );
}

/**
 * @param {Connect4State} state
 * @returns {string[]} Board rows, top row first, one cell per column.
 */
function boardRows(state) {
  const rows = [];
  for (let row = HEIGHT - 1; row >= 0; row--) {
    const cells = [];
    for (let col = 0; col < WIDTH; col++) {
      const idx = col * 7 + row;
      const x = idx < 28 ? (state.bb[0] >>> idx) & 1 : (state.bb[1] >>> (idx - 28)) & 1;
      const o = idx < 28 ? (state.bb[2] >>> idx) & 1 : (state.bb[3] >>> (idx - 28)) & 1;
      cells.push(x === 1 ? 'X' : o === 1 ? 'O' : '.');
    }
    rows.push(cells.join(' '));
  }
  return rows;
}

export const connect4 = {
  spec: {
    id: 'connect4',
    version: '1.1.0',
    title: 'Connect Four',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning', 'deduction']),
    benchmark: true,
    requires: [],
    rulesText:
      'Connect Four on a 7-column by 6-row vertical board. Columns are numbered 1 (leftmost) ' +
      'through 7 (rightmost); this game uses 1-based column numbers. Seat 0 plays X and seat 1 ' +
      'plays O; the observation names which seat moves. On your turn, drop one of your discs ' +
      'into any column that is not full: it falls to the lowest empty row of that column. You ' +
      'win by making a straight line of four of your discs horizontally, vertically, or ' +
      'diagonally. A full board with no line of four is a draw. ' +
      'Action grammar: the column number alone, e.g. "4" drops into column 4. Documented ' +
      'alternates: "column 4", "col 4", "play 4", "drop 4", "place 4", "move 4", uppercase ' +
      'letters, surrounding quotes or backticks, and surrounding whitespace are all accepted. ' +
      'Dropping into a full or unknown column is invalid and consumes an action attempt. ' +
      'On the forced-win tier, the observation announces a position where you have a proven ' +
      'forced win; play it out and convert it.',
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'ladder-1',
        rank: 1,
        scoring: 'outcome',
        maxActions: 30,
        publicSeeds: 12,
        params: { opponent: 'random' },
      },
      {
        id: 'ladder-0',
        rank: 2,
        scoring: 'outcome',
        maxActions: 30,
        // 16 public seeds: the on-ramp verdict needs >= 16 scored episodes.
        publicSeeds: 16,
        params: { opponent: 'engine', depth: 2 },
      },
      {
        id: 'ladder-2',
        rank: 3,
        scoring: 'outcome',
        maxActions: 30,
        publicSeeds: 12,
        params: { opponent: 'engine', depth: 4 },
      },
      {
        id: 'ladder-3',
        rank: 4,
        scoring: 'outcome',
        maxActions: 30,
        publicSeeds: 12,
        params: { opponent: 'engine', depth: 8 },
      },
      {
        id: 'ladder-4',
        rank: 5,
        scoring: 'outcome',
        maxActions: 30,
        publicSeeds: 12,
        params: { opponent: 'engine', depth: 12 },
      },
      {
        id: 'forced-win',
        rank: 6,
        scoring: 'outcome',
        maxActions: 30,
        publicSeeds: 12,
        params: { opponent: 'engine', depth: 12, exact: true, minWinPlies: MIN_WIN_PLIES, maxWinPlies: MAX_WIN_PLIES },
      },
    ]),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {Connect4State}
   */
  reset(tier, seed) {
    const agentSeat = seatForSeed(tier, seed);
    if (tier.id === 'forced-win') {
      return generateForcedWinPosition(agentSeat, seed);
    }
    return withSeededOpening(emptyState(agentSeat), `${tier.id}/${seed}`);
  },

  /**
   * @param {Connect4State} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? state.toMove : null;
  },

  /**
   * @param {Connect4State} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const you = MARKS[seat];
    const mover = MARKS[state.toMove];
    const rows = ['  1 2 3 4 5 6 7'].concat(boardRows(state));
    const legal =
      state.status === 'playing'
        ? COLUMNS.filter((name) => state.heights[Number(name) - 1] < HEIGHT)
        : [];
    const statusText =
      state.status === 'playing'
        ? `${mover} to move.`
        : state.status === 'draw'
          ? 'Game over: draw.'
          : `Game over: ${MARKS[/** @type {number} */ (state.winner)]} wins.`;
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : 'Legal actions: none (game over).';
    const lines = [
      `Connect Four. You are seat ${seat} (${you}). Seat 0 is X, seat 1 is O.`,
      'Columns are numbered 1 (leftmost) through 7 (rightmost); discs fall to the lowest empty row.',
      rows.join('\n'),
      statusText,
      legalText,
    ];
    if (state.forcedWinPlies !== null && state.status === 'playing') {
      lines.push(
        `Analysis: a forced win for you exists from this position; perfect play completes it in at most ${state.forcedWinPlies} plies.`
      );
    }
    return {
      text: lines.join('\n'),
      data: { ...state, you: seat },
    };
  },

  /**
   * @param {Connect4State} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== state.toMove) return [];
    return legalCols(state).map((col) => String(col + 1));
  },

  /**
   * @param {Connect4State} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== state.toMove) {
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
    s = s.toLowerCase().replace(/^(play|drop|place|move|choose)\s+/, '');
    const match = /^(?:column\s*|col\s*)?([1-7])$/.exec(s);
    if (!match) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a column; use the column number 1-7, e.g. "4" or "column 4"`,
      };
    }
    const col = Number(match[1]) - 1;
    if (state.heights[col] >= HEIGHT) {
      return { ok: false, error: `column ${match[1]} is full` };
    }
    return { ok: true, action: match[1] };
  },

  /**
   * @param {Connect4State} state
   * @param {number} seat
   * @param {string} action
   * @returns {Connect4State}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== state.toMove) {
      throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
    }
    const parsed = this.parseAction(state, seat, action);
    if (!parsed.ok) {
      throw new GauntletRuleError(parsed.error);
    }
    return applyMove(state, seat, Number(parsed.action) - 1);
  },

  /**
   * @param {Connect4State} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    if (state.status === 'draw') {
      return {
        normalized: [0.5, 0.5],
        raw: ['draw', 'draw'],
        reason: 'draw: the board filled with no line of four',
      };
    }
    const winner = /** @type {number} */ (state.winner);
    return {
      normalized: winner === 0 ? [1, 0] : [0, 1],
      raw: winner === 0 ? ['win', 'loss'] : ['loss', 'win'],
      reason: `seat ${winner} (${MARKS[winner]}) connected four after ${state.discs} discs`,
    };
  },

  /**
   * Budget truncation on this outcome tier scores the position as perfect
   * play would decide it: an exact solve at 30 or more discs, a depth-12
   * search below that. A forced win for the agent scores 1, a forced win for
   * the opponent 0, anything else 0.5.
   *
   * @param {Connect4State} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    const agentSeat = state.agentSeat;
    let winnerSeat;
    let how;
    if (state.discs >= EXACT_MIN_DISCS) {
      const value = solveExact(state);
      winnerSeat =
        value.verdict === 'draw' ? null : value.verdict === 'win' ? state.toMove : 1 - state.toMove;
      how = `exact solve (${value.verdict}${value.plies !== null ? ` in ${value.plies} plies` : ''})`;
    } else {
      const choice = chooseMove(state, { depth: 12 });
      if (choice.score > WIN_SCORE - 256) {
        winnerSeat = state.toMove;
        how = `depth-12 search (win in ${WIN_SCORE - choice.score} plies)`;
      } else if (choice.score < -(WIN_SCORE - 256)) {
        winnerSeat = 1 - state.toMove;
        how = `depth-12 search (loss in ${WIN_SCORE + choice.score} plies)`;
      } else {
        winnerSeat = null;
        how = 'depth-12 search (unclear)';
      }
    }
    let normalized;
    let reason;
    if (winnerSeat === null || winnerSeat === undefined) {
      normalized = [0.5, 0.5];
      reason = `truncated: the position assesses as drawn, ${how}`;
    } else if (winnerSeat === agentSeat) {
      normalized = agentSeat === 0 ? [1, 0] : [0, 1];
      reason = `truncated: the agent has a forced win, ${how}`;
    } else {
      normalized = agentSeat === 0 ? [0, 1] : [1, 0];
      reason = `truncated: the opponent has a forced win, ${how}`;
    }
    return { normalized, raw: null, reason };
  },

  /**
   * The opponent agent for the seat the agent is not in: seeded uniform
   * random on ladder-1, the negamax engine at the tier's depth on the other
   * ladders (depth 2 on ladder-0, 4/8/12 on ladder-2..4), and the strongest
   * engine (exact play at every depth) on the forced-win tier.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    const params = /** @type {{ opponent: string, depth?: number, exact?: boolean }} */ (tier.params);
    const seedKey = `${tier.id}/${seed}/opponent/${seat}/turn`;
    if (params.opponent === 'random') {
      return {
        id: 'random-opponent',
        track: 'baseline',
        async act(/** @type {TurnContext} */ ctx) {
          const state = /** @type {Connect4State} */ (ctx.observation.data);
          if (state.status !== 'playing') {
            throw new GauntletRuleError('random opponent asked to move in a finished game');
          }
          const cols = legalCols(state);
          if (cols.length === 0) {
            throw new GauntletRuleError('random opponent found no legal move');
          }
          const stream = streamFromSeed(`${seedKey}${ctx.turn}`);
          const pick = nextInt(stream.getState(), 0, cols.length - 1);
          return { text: String(cols[pick.value] + 1) };
        },
      };
    }
    const depth = /** @type {number} */ (params.depth);
    return {
      id: params.exact ? 'engine-exact-d' + depth : 'engine-d' + depth,
      track: 'baseline',
      async act(/** @type {TurnContext} */ ctx) {
        const state = /** @type {Connect4State} */ (ctx.observation.data);
        if (state.status !== 'playing') {
          throw new GauntletRuleError('engine opponent asked to move in a finished game');
        }
        const key = `${seedKey}${ctx.turn}`;
        // On the forced-win tier the opponent defends exactly at every depth:
        // below EXACT_MIN_DISCS the depth-12 search blunders in deep wins, and
        // those blunders are what let weak agents convert the proven win by
        // luck. Exact defense never concedes it.
        if (params.exact) {
          const choice = chooseExactMove(state, key);
          return { text: String(choice.col + 1) };
        }
        const choice = chooseMove(state, { depth, seedKey: key });
        return { text: String(choice.col + 1) };
      },
    };
  },

  /**
   * The agent's seat alternates with the seed.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {number}
   */
  agentSeat(tier, seed) {
    return seatForSeed(tier, seed);
  },
};

/** @type {Game<Connect4State>} */
export default connect4;
