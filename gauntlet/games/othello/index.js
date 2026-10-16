/**
 * Othello (Reversi): a Gauntlet game. Two seats, perfect information, an
 * engine ladder of fixed node budgets, outcome scored 1 / 0.5 / 0 by final
 * disc majority. Squares use standard Othello notation: files a-h run left
 * to right, ranks 1-8 run top to bottom, so a1 is the top-left corner; the
 * choice is stated in rulesText and in every observation.
 *
 * Ladder tiers open with 0 to 3 seeded random plies (the first three plies
 * of Othello always have legal placements, so no opening pass handling is
 * needed in practice; a pass is still applied defensively if one appears).
 * The agent's seat alternates with the seed, so it plays both colours across
 * the public seed set.
 *
 * A player with no legal placement must play the exact text "pass"; the
 * game ends when the board is full or neither side can place.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { fnv1a64 } from '../../core/canonical.js';
import { nextInt, rngFromSeed, streamFromSeed } from '../../core/rng.js';

import {
  HEIGHT,
  WIDTH,
  applyPass,
  applyPlacement,
  discCounts,
  emptyState,
  legalPlacements,
  parseName,
  nameOf,
} from './rules.js';
import { chooseMove } from './engine.js';

/** @import { Agent, Game, InformationMode, Observation, Outcome, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */
/** @import { OthelloState } from './rules.js' */

const SEAT_NAMES = ['Black', 'White'];

/** Number of seeded random opening plies: 0 to 3. */
const MAX_OPENING_PLIES = 3;

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
 * 0 to 3 seeded random opening plies. Every early position in Othello has
 * legal placements, so a pass should never occur here; if one would, it is
 * applied defensively and the opening stops.
 *
 * @param {OthelloState} state
 * @param {string} key Seed key for the opening stream.
 * @returns {OthelloState}
 */
function withSeededOpening(state, key) {
  const stream = rngFromSeed(`${key}/opening`);
  const plies = nextInt(stream, 0, MAX_OPENING_PLIES);
  let current = state;
  let played = 0;
  for (let i = 0; i < plies.value; i++) {
    if (current.status !== 'playing') break;
    const legal = legalPlacements(current, current.toMove);
    if (legal.length === 0) {
      current = applyPass(current, current.toMove);
      break;
    }
    const pick = nextInt(plies.state, 0, legal.length - 1);
    current = applyPlacement(current, current.toMove, legal[pick.value].charCodeAt(0) - 97, Number(legal[pick.value][1]) - 1);
    plies.state = pick.state;
    played++;
  }
  return { ...current, openingPlies: played };
}

/**
 * The board as text rows, rank 1 (top) first, with file and rank rulers.
 *
 * @param {OthelloState} state
 * @returns {string[]}
 */
function boardLines(state) {
  const lines = ['    a b c d e f g h'];
  for (let row = 0; row < HEIGHT; row++) {
    const cells = [];
    for (let col = 0; col < WIDTH; col++) {
      const bit = row * 8 + col;
      const black = bit < 32 ? (state.bb[0] >>> bit) & 1 : (state.bb[1] >>> (bit - 32)) & 1;
      const white = bit < 32 ? (state.bb[2] >>> bit) & 1 : (state.bb[3] >>> (bit - 32)) & 1;
      cells.push(black === 1 ? 'B' : white === 1 ? 'W' : '.');
    }
    lines.push(`  ${row + 1} ${cells.join(' ')}`);
  }
  return lines;
}

export const othello = {
  spec: {
    id: 'othello',
    version: '1.0.0',
    title: 'Othello (Reversi)',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning']),
    benchmark: true,
    requires: [],
    rulesText:
      'Othello (Reversi) on an 8x8 board. Files a-h run left to right and ranks 1-8 run top to ' +
      'bottom, so a1 is the top-left corner; the standard opening has White discs on d4 and e5 ' +
      'and Black discs on d5 and e4, with Black to move. Seat 0 plays Black and seat 1 plays ' +
      'White; the observation names which seat moves and renders the board with rank labels. ' +
      'On your turn, place one of your discs on an empty square such that at least one straight ' +
      'line (horizontal, vertical, or diagonal) of one or more opponent discs is bracketed ' +
      'between the placed disc and another of your discs; every bracketed opponent disc flips ' +
      'to your colour. You cannot pass while you have a legal placement. If you have no legal ' +
      'placement, your only legal action is the exact text "pass". The game ends when the ' +
      'board is full or neither side has a legal placement; the player with more discs wins ' +
      'and equal counts are a draw. ' +
      'Action grammar: the file letter followed by the rank digit, e.g. "d3" places a disc on ' +
      'square d3. Documented alternates: "play d3", "move d3", "place d3", uppercase letters ' +
      '("D3"), surrounding quotes or backticks, and surrounding whitespace are all accepted. ' +
      'A placement that brackets nothing, an occupied square, or a pass while you have a legal ' +
      'placement is invalid and consumes an action attempt.',
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'ladder-1',
        rank: 1,
        scoring: 'outcome',
        maxActions: 90,
        publicSeeds: 12,
        params: { opponent: 'random' },
      },
      {
        id: 'ladder-2',
        rank: 2,
        scoring: 'outcome',
        maxActions: 90,
        publicSeeds: 12,
        params: { opponent: 'engine', nodes: 400 },
      },
      {
        id: 'ladder-3',
        rank: 3,
        scoring: 'outcome',
        maxActions: 90,
        publicSeeds: 12,
        params: { opponent: 'engine', nodes: 4000 },
      },
      {
        id: 'ladder-4',
        rank: 4,
        scoring: 'outcome',
        maxActions: 90,
        publicSeeds: 12,
        params: { opponent: 'engine', nodes: 32000 },
      },
    ]),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {OthelloState}
   */
  reset(tier, seed) {
    const agentSeat = seatForSeed(tier, seed);
    return withSeededOpening(emptyState(agentSeat), `${tier.id}/${seed}`);
  },

  /**
   * @param {OthelloState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? state.toMove : null;
  },

  /**
   * @param {OthelloState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const you = SEAT_NAMES[seat];
    const mover = SEAT_NAMES[state.toMove];
    const [black, white] = discCounts(state);
    const legal =
      state.status === 'playing'
        ? legalPlacements(state, seat === state.toMove ? seat : state.toMove)
        : [];
    const statusText =
      state.status === 'playing'
        ? `${mover} to move.`
        : black === white
          ? `Game over: draw, ${black}-${white}.`
          : black > white
            ? `Game over: Black wins ${black}-${white}.`
            : `Game over: White wins ${white}-${black}.`;
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : state.status === 'playing' && seat === state.toMove
          ? 'Legal actions (1, at most 64 so all are listed): pass — you have no legal placement this turn.'
          : 'Legal actions: none.';
    const lines = [
      `Othello (Reversi). You are seat ${seat} (${you}). Seat 0 is Black (B), seat 1 is White (W); Black moves first.`,
      'Files a-h run left to right, ranks 1-8 run top to bottom; a1 is the top-left corner. Place a disc so it brackets one or more opponent discs in a straight line between the new disc and one of your own; every bracketed opponent disc flips to your colour.',
      boardLines(state).join('\n'),
      `Discs: Black ${black}, White ${white}. ${statusText}`,
      legalText,
    ];
    return {
      text: lines.join('\n'),
      data: { ...state, you: seat },
    };
  },

  /**
   * @param {OthelloState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== state.toMove) return [];
    const placements = legalPlacements(state, seat);
    return placements.length > 0 ? placements : ['pass'];
  },

  /**
   * @param {OthelloState} state
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
    s = s.toLowerCase().replace(/^(play|move|place|choose)\s+/, '');
    if (s === 'pass') {
      const placements = legalPlacements(state, seat);
      if (placements.length > 0) {
        return {
          ok: false,
          error: 'you have a legal placement, so you cannot pass',
        };
      }
      return { ok: true, action: 'pass' };
    }
    const square = parseName(s);
    if (!square) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a square; use a file letter a-h and a rank digit 1-8, e.g. "d3", or "pass" when you have no placement`,
      };
    }
    const name = nameOf(square.col, square.row);
    const placements = legalPlacements(state, seat);
    if (!placements.includes(name)) {
      if (placements.length === 0) {
        return { ok: false, error: `you have no legal placement this turn; your only legal action is "pass"` };
      }
      // Distinguish the two failure modes for a precise error.
      try {
        applyPlacement(state, seat, square.col, square.row);
        return { ok: false, error: 'unreachable' };
      } catch (err) {
        if (err instanceof GauntletRuleError) {
          return { ok: false, error: err.message };
        }
        throw err;
      }
    }
    return { ok: true, action: name };
  },

  /**
   * @param {OthelloState} state
   * @param {number} seat
   * @param {string} action
   * @returns {OthelloState}
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
    if (parsed.action === 'pass') {
      return applyPass(state, seat);
    }
    return applyPlacement(state, seat, parsed.action.charCodeAt(0) - 97, Number(parsed.action[1]) - 1);
  },

  /**
   * @param {OthelloState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status !== 'over') return null;
    const [black, white] = discCounts(state);
    if (black === white) {
      return {
        normalized: [0.5, 0.5],
        raw: ['draw', 'draw'],
        reason: `draw: ${black} discs each after ${state.discs} placements`,
      };
    }
    const winner = black > white ? 0 : 1;
    return {
      normalized: winner === 0 ? [1, 0] : [0, 1],
      raw: winner === 0 ? ['win', 'loss'] : ['loss', 'win'],
      reason: `seat ${winner} (${SEAT_NAMES[winner]}) wins ${Math.max(black, white)}-${Math.min(black, white)} on discs after ${state.discs} placements`,
    };
  },

  /**
   * Budget truncation on this outcome tier scores by the disc majority on
   * the board when the budget ran out: the leader (or disc equality) decides,
   * and the reason says so. Deterministic and honest — it is a position
   * snapshot, not an engine assessment.
   *
   * @param {OthelloState} state
   * @returns {Outcome}
   */
  truncate(state) {
    if (state.status === 'over') {
      return /** @type {Outcome} */ (this.outcome(state));
    }
    const [black, white] = discCounts(state);
    const agentSeat = state.agentSeat;
    const agentDiscs = agentSeat === 0 ? black : white;
    const oppDiscs = agentSeat === 0 ? white : black;
    let normalized;
    let reason;
    if (agentDiscs === oppDiscs) {
      normalized = [0.5, 0.5];
      reason = `truncated: disc counts are level ${black}-${white}`;
    } else if (agentDiscs > oppDiscs) {
      normalized = agentSeat === 0 ? [1, 0] : [0, 1];
      reason = `truncated: the agent leads ${Math.max(black, white)}-${Math.min(black, white)} on discs`;
    } else {
      normalized = agentSeat === 0 ? [0, 1] : [1, 0];
      reason = `truncated: the opponent leads ${Math.max(black, white)}-${Math.min(black, white)} on discs`;
    }
    return { normalized, raw: null, reason };
  },

  /**
   * The opponent agent for the seat the agent is not in: seeded uniform
   * random on ladder-1, the negamax engine at the tier's node budget on the
   * other ladders.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    const params = /** @type {{ opponent: string, nodes?: number }} */ (tier.params);
    const seedKey = `${tier.id}/${seed}/opponent/${seat}/turn`;
    if (params.opponent === 'random') {
      return {
        id: 'random-opponent',
        track: 'baseline',
        async act(/** @type {TurnContext} */ ctx) {
          const state = /** @type {OthelloState} */ (ctx.observation.data);
          if (state.status !== 'playing') {
            throw new GauntletRuleError('random opponent asked to move in a finished game');
          }
          const legal = legalActionsOf(state);
          if (legal.length === 0) {
            throw new GauntletRuleError('random opponent found no legal action');
          }
          const stream = streamFromSeed(`${seedKey}${ctx.turn}`);
          const pick = nextInt(stream.getState(), 0, legal.length - 1);
          return { text: legal[pick.value] };
        },
      };
    }
    const nodeBudget = /** @type {number} */ (params.nodes);
    return {
      id: `engine-n${nodeBudget}-opponent`,
      track: 'baseline',
      async act(/** @type {TurnContext} */ ctx) {
        const state = /** @type {OthelloState} */ (ctx.observation.data);
        if (state.status !== 'playing') {
          throw new GauntletRuleError('engine opponent asked to move in a finished game');
        }
        const legal = legalPlacements(state, state.toMove);
        if (legal.length === 0) {
          return { text: 'pass' };
        }
        const choice = chooseMove(state, { nodeBudget });
        return { text: choice.move };
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

/**
 * Legal actions for an opponent reading the observation data directly
 * (placements sorted, or the single action "pass").
 *
 * @param {OthelloState} state
 * @returns {string[]}
 */
function legalActionsOf(state) {
  const placements = legalPlacements(state, state.toMove);
  return placements.length > 0 ? placements : ['pass'];
}

/** @type {Game<OthelloState>} */
export default othello;
