/**
 * The Go (9x9) game: wiring the pure rules into the shared game contract —
 * spec with tiers, observations, action parsing, stepping, and outcomes.
 * Rules, scoring, and the state layout are documented in `rules.js`.
 *
 * Structure mirrors `games/othello/index.js` (two-seat adversarial game,
 * deterministic seat assignment that alternates with the seed, a seeded
 * random onramp ladder plus stronger rungs, truncation to an area count).
 * The stronger rungs shell out to a local GNU Go binary through the GTP
 * client, so this packet is Node-only in practice (like chess-stockfish);
 * the rules and game modules themselves stay browser-import-safe.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { fnv1a64 } from '../../core/canonical.js';
import { nextInt, streamFromSeed } from '../../core/rng.js';

import { areaScore, checkMove, emptyState, nameOf, parseName, passGo, playGo } from './rules.js';
import { createGreedyAgent, createGtpEngineAgent } from './baselines.js';

/** @import { Agent, Game, InformationMode, Observation, Outcome, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */
/** @import { GoState } from './rules.js' */

const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'];
const SEAT_NAMES = ['Black', 'White'];

/** The rules and action grammar every agent sees (official track included). */
const RULES_TEXT =
  'Go on a 9x9 board. Columns A B C D E F G H J run left to right (the letter I does not ' +
  'exist) and ranks 1-9 run bottom to top, so A1 is the bottom-left corner; vertices are ' +
  'written as column letter then rank digit, e.g. "D5". Seat 0 plays Black (X) and seat 1 ' +
  'plays White (O); Black moves first, and the observation names which seat moves and ' +
  'renders the board with rank labels. On your turn, either play one stone on an empty ' +
  'point or play the exact text "pass". Orthogonally adjacent stones of the same colour ' +
  'form a group; a group with no adjacent empty point (no liberties) is captured and ' +
  'removed. A play that captures removes the captured stones first; suicide (playing into ' +
  'a point that leaves your own group with no liberties and captures nothing) is illegal. ' +
  'A play may not recreate any earlier whole-board position (positional superko), which ' +
  'also bars immediate recapture in a ko; when a single-stone capture leaves the capturing ' +
  'stone alone with exactly one liberty, the observation names the barred point. The game ' +
  'ends after two consecutive passes. Scoring is area (Chinese): a player\'s score is ' +
  'their stones on the board plus empty points bordered only by their stones; points ' +
  'bordered by both colours or by neither are neutral. White receives komi 7, so counts ' +
  'are integers and a jigo (draw) is possible. ' +
  'Action grammar: the bare vertex "D5", or "play D5" / "move D5" / "place D5", uppercase ' +
  'or lowercase, with surrounding quotes, backticks or whitespace, all accepted; "pass" ' +
  'passes. An occupied point, a suicide, a superko violation, or a malformed vertex is ' +
  'invalid and consumes an action attempt.';

/**
 * The agent's seat alternates with the seed, so it plays both colours across
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
 * Legal actions for the seat to act: every empty point whose placement passes
 * the capture, suicide, and superko checks, plus "pass". Sorted
 * lexicographically.
 *
 * @param {GoState} state
 * @param {number} seat
 * @returns {string[]}
 */
function legalActionsOf(state, seat) {
  if (state.status !== 'playing' || seat !== state.toMove) return [];
  /** @type {string[]} */
  const actions = ['pass'];
  for (let index = 0; index < state.board.length; index++) {
    if (state.board[index] !== 0) continue;
    const col = index % 9;
    const row = (index / 9) | 0;
    if (checkLegal(state, seat, col, row)) actions.push(`play ${nameOf(col, row)}`);
  }
  return actions.sort();
}

/**
 * @param {GoState} state
 * @param {number} seat
 * @param {number} col
 * @param {number} row
 * @returns {boolean}
 */
function checkLegal(state, seat, col, row) {
  return checkMove(state, seat, col, row).ok;
}

/**
 * The board as text rows, rank 9 (top) first, with column and rank rulers.
 *
 * @param {GoState} state
 * @returns {string[]}
 */
function boardLines(state) {
  const lines = ['    A B C D E F G H J'];
  for (let row = 8; row >= 0; row--) {
    const cells = [];
    for (let col = 0; col < 9; col++) {
      const stone = state.board[row * 9 + col];
      cells.push(stone === 1 ? 'X' : stone === 2 ? 'O' : '.');
    }
    lines.push(`  ${row + 1} ${cells.join(' ')}`);
  }
  return lines;
}

/**
 * Everything an agent sees: seat identity, the board, captures, consecutive
 * passes, the barred ko point, the running area count, and the legal-action
 * list. Like Othello, the list names the mover's actions and is elided above
 * 64 entries — on the empty board all 81 placements are legal, and the rules
 * text says what a legal play is.
 *
 * @param {GoState} state
 * @param {number} seat
 * @returns {Observation}
 */
function observeState(state, seat) {
  const you = SEAT_NAMES[seat];
  const mover = SEAT_NAMES[state.toMove];
  const score = areaScore(state.board);
  const legal = legalActionsOf(state, state.toMove);
  const statusText =
    state.status === 'playing'
      ? `${mover} to move.`
      : score.black === score.white
        ? `Game over: jigo, ${score.black}-${score.white}.`
        : score.black > score.white
          ? `Game over: Black wins ${score.black}-${score.white} on area.`
          : `Game over: White wins ${score.white}-${score.black} on area.`;
  const legalText =
    legal.length > 64
      ? `Legal actions (${legal.length} > 64, not listed): play any empty point whose group keeps a liberty, or pass.`
      : legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : 'Legal actions: none.';
  const lines = [
    `Go (9x9). You are seat ${seat} (${you}). Seat 0 is Black (X), seat 1 is White (O); Black moves first. A1 is the bottom-left corner.`,
    'Play a stone on an empty point or pass. Groups with no liberties are captured; suicide and recreating an earlier position are illegal; two consecutive passes end the game, scored by area with komi 7 for White.',
    boardLines(state).join('\n'),
    `Captures: Black ${state.captures[0]}, White ${state.captures[1]}. Consecutive passes: ${state.passes} (game ends at two).`,
    state.koPoint ? `Ko: immediately recapturing at ${state.koPoint} is barred by superko.` : null,
    `Area count if the game ended now: Black ${score.black}, White ${score.white} (komi 7 included in White's count). ${statusText}`,
    legalText,
  ].filter((line) => line !== null);
  return {
    text: lines.join('\n'),
    data: { ...state, you: seat },
  };
}

export const go = {
  spec: {
    id: 'go',
    version: '1.0.0',
    title: 'Go (9x9)',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning', 'spatial']),
    benchmark: true,
    requires: ['gnugo'],
    rulesText: RULES_TEXT,
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'ladder-1',
        rank: 1,
        scoring: 'outcome',
        maxActions: 120,
        publicSeeds: 12,
        params: { opponent: 'random' },
      },
      {
        id: 'ladder-2',
        rank: 2,
        scoring: 'outcome',
        maxActions: 120,
        publicSeeds: 12,
        params: { opponent: 'gnugo', level: 1 },
      },
      {
        id: 'ladder-3',
        rank: 3,
        scoring: 'outcome',
        maxActions: 120,
        publicSeeds: 12,
        params: { opponent: 'gnugo', level: 5 },
      },
      {
        id: 'ladder-4',
        rank: 4,
        scoring: 'outcome',
        maxActions: 120,
        publicSeeds: 12,
        params: { opponent: 'gnugo', level: 10 },
      },
    ]),
  },

  /**
   * Fresh empty board, Black to move; the seat assignment is fixed by the
   * tier and seed.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {GoState}
   */
  reset(tier, seed) {
    return emptyState(seatForSeed(tier, seed));
  },

  /**
   * @param {GoState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? state.toMove : null;
  },

  /**
   * @param {GoState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    return observeState(state, seat);
  },

  /**
   * @param {GoState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    return legalActionsOf(state, seat);
  },

  /**
   * Accepts the documented alternates and returns the canonical action
   * ("play D5" or "pass"). Rule violations (occupied point, suicide, superko)
   * surface their precise reasons here.
   *
   * @param {GoState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== state.toMove) {
      return { ok: false, error: `it is seat ${state.toMove}'s turn, not seat ${seat}'s` };
    }
    let s = String(text).trim();
    s = s.replace(/^action\s*:\s*/i, '').trim();
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.toLowerCase().replace(/^(play|move|place|choose)\s+/, '').trim();
    if (s === 'pass') {
      return { ok: true, action: 'pass' };
    }
    const vertex = parseName(s.toUpperCase());
    if (!vertex) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a vertex; use a column letter A-J without I and a rank digit 1-9, e.g. "D5", or "pass"`,
      };
    }
    const canonical = `play ${nameOf(vertex.col, vertex.row)}`;
    const check = checkMove(state, seat, vertex.col, vertex.row);
    if (!check.ok) {
      return { ok: false, error: /** @type {string} */ (check.error) };
    }
    return { ok: true, action: canonical };
  },

  /**
   * Pure; throws GauntletRuleError for anything not in legalActions.
   *
   * @param {GoState} state
   * @param {number} seat
   * @param {string} action
   * @returns {GoState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== state.toMove) {
      throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
    }
    if (action === 'pass') {
      return passGo(state, seat);
    }
    const m = /^play ([A-J])([1-9])$/.exec(action);
    if (!m) {
      throw new GauntletRuleError(`unrecognized action ${JSON.stringify(action)}`);
    }
    return playGo(state, seat, COLUMN_LETTERS.indexOf(m[1]), Number(m[2]) - 1);
  },

  /**
   * The area result of the finished position. raw holds each seat's area
   * total (White's includes komi 7).
   *
   * @param {GoState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status !== 'over') return null;
    const score = areaScore(state.board);
    if (score.black === score.white) {
      return {
        normalized: [0.5, 0.5],
        raw: [String(score.black), String(score.white)],
        reason: `jigo (draw): area ${score.black} each, komi 7 included in White's count`,
      };
    }
    const winner = score.black > score.white ? 0 : 1;
    return {
      normalized: winner === 0 ? [1, 0] : [0, 1],
      raw: [String(score.black), String(score.white)],
      reason:
        winner === 0
          ? `seat 0 (Black) wins by ${score.black - score.white} on area: Black ${score.black}, White ${score.white} (komi 7 included)`
          : `seat 1 (White) wins by ${score.white - score.black} on area: White ${score.white}, Black ${score.black} (komi 7 included)`,
    };
  },

  /**
   * Budget truncation scores by the area count on the board when the budget
   * ran out: the leader (or equality) decides, and the reason says so.
   * Deterministic and honest — it is a position snapshot, not an engine
   * assessment.
   *
   * @param {GoState} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status === 'over') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    const score = areaScore(state.board);
    const agentSeat = state.agentSeat;
    const agentTotal = agentSeat === 0 ? score.black : score.white;
    const oppTotal = agentSeat === 0 ? score.white : score.black;
    if (agentTotal === oppTotal) {
      return {
        normalized: [0.5, 0.5],
        raw: null,
        reason: `truncated: area counts are level — Black ${score.black}, White ${score.white} (komi 7 included in White's count)`,
      };
    }
    const agentWon = agentTotal > oppTotal;
    return {
      normalized: (agentSeat === 0) === agentWon ? [1, 0] : [0, 1],
      raw: null,
      reason: agentWon
        ? `truncated: the agent leads ${Math.max(score.black, score.white)}-${Math.min(score.black, score.white)} on area`
        : `truncated: the opponent leads ${Math.max(score.black, score.white)}-${Math.min(score.black, score.white)} on area`,
    };
  },

  /**
   * The opponent agent for the seat the agent is not in: seeded uniform
   * random on ladder-1, a local GNU Go at the tier's level on the other
   * ladders. Engine opponents carry dispose(), which the runner calls in the
   * episode's finally.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    const params = /** @type {{ opponent: string, level?: number }} */ (tier.params);
    if (params.opponent === 'random') {
      const seedKey = `${tier.id}/${seed}/opponent/${seat}/turn`;
      return {
        id: 'random-opponent',
        track: 'baseline',
        async act(/** @type {TurnContext} */ ctx) {
          const state = /** @type {GoState} */ (ctx.observation.data);
          if (state.status !== 'playing') {
            throw new GauntletRuleError('random opponent asked to move in a finished game');
          }
          const legal = legalActionsOf(state, state.toMove);
          if (legal.length === 0) {
            throw new GauntletRuleError('random opponent found no legal action');
          }
          const stream = streamFromSeed(`${seedKey}${ctx.turn}`);
          const pick = nextInt(stream.getState(), 0, legal.length - 1);
          return { text: legal[pick.value] };
        },
      };
    }
    return createGtpEngineAgent({
      id: `gnugo-level-${params.level ?? 10}-opponent`,
      level: params.level ?? 10,
      episodeSeed: `${tier.id}/${seed}/opponent/${seat}`,
    });
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

/** @type {Game<GoState>} */
export default go;

export { createGreedyAgent, createGtpEngineAgent };
