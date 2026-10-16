/**
 * Heads-up limit Texas hold'em for PlayKit Gauntlet. Two seats, hidden
 * information, stochastic. One episode is a duplicate match of 20 deals,
 * each dealt twice with the seats swapped (40 hands), so both sides receive
 * the same cards over the match and card luck largely cancels: a seat's
 * score measures play quality, not the deal. Fixed-limit betting (blinds 1
 * and 2, small bet 2, big bet 4, at most four bets per street), stacks reset
 * every hand. Outcome scored by a sigmoid of the agent's bb100 over the
 * match: 0.5 is break-even.
 *
 * Tiers are ranked fixed opponents: `station` (always calls), `rules`
 * (preflop chart + made-hand strength), `equity` (Monte Carlo equity against
 * a uniform range). Baselines live in `baselines.js`.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { TOTAL_HANDS, applyAction, canRaise, matchOutcome, newMatch, seatToAct, toCall, truncateOutcome, visibleBoard } from './engine.js';
import { cardsText } from './cards.js';
import { makeOpponent } from './opponents.js';

/** @import { Agent, Game, GameSpec, Observation, ParseResult, TierSpec } from '../../core/types.js' */
/** @import { HoldemData } from './opponents.js' */
/** @import { MatchState } from './engine.js' */

export const GAME_ID = 'holdem';
export const GAME_VERSION = '1.2.0';

/**
 * The hold'em spec. benchmark: true per the design doc's roster.
 *
 * @type {GameSpec}
 */
const spec = {
  id: GAME_ID,
  version: GAME_VERSION,
  title: "Heads-Up Limit Texas Hold'em",
  seats: /** @type {1 | 2} */ (2),
  information: /** @type {import('../../core/types.js').InformationMode} */ ('hidden'),
  stochastic: true,
  tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'probabilistic']),
  benchmark: true,
  requires: [],
  rulesText: [
    "Heads-up fixed-limit Texas hold'em against a fixed opponent bot. You are seat 0; the opponent is seat 1.",
    'One episode is a duplicate match of 20 deals, each dealt twice with the seats swapped (40 hands total), so both players receive the same cards over the match and card luck cancels. Stacks reset every hand, but chip totals carry across the match.',
    'Betting: fixed limit. The dealer posts a small blind of 1 and the other seat a big blind of 2. Preflop and flop bets are 2 each; turn and river bets are 4 each. At most four bets per street (the first bet or raise sequence counts the blind preflop); after the cap only call or fold remain. No all-ins are possible (the cap bounds a hand at 24 chips).',
    'Order of play: preflop the dealer acts first; after the flop the non-dealer acts first. A betting round ends when both players have acted and matched the current bet; then the next board card(s) are revealed. After the river betting, hands are shown down and the best five-card hand out of seven wins the pot; exact ties split it.',
    'Actions: "fold" (give up the hand), "call" (match the current bet; it means check when nothing to call), "raise" (bet or raise by the street increment: 2 preflop/flop, 4 turn/river).',
    "Action grammar: the canonical actions are exactly fold, call, raise. Documented alternates: check (means call), bet (means raise), optional trailing amounts like \"raise 4\" (informational; the engine applies the fixed-limit increment), uppercase, surrounding quotes or backticks, and a leading action verb such as \"I fold\". Unknown actions are invalid and consume an action attempt.",
    'Scoring: your episode score is 1 / (1 + exp(-bb100/50)), where bb100 is your big blinds won per 100 hands over the match (0.5 = break-even). Observations show your hole cards, the board, the pot, the betting, hand and match progress, chip totals, and earlier showdowns. The opponent\'s cards are never shown before a showdown.',
  ].join('\n'),
  tiers: /** @type {TierSpec[]} */ ([
    {
      id: 'station',
      rank: 1,
      scoring: 'outcome',
      maxActions: 400,
      publicSeeds: 12,
      params: { opponent: 'station', duplicateDeals: 20 },
    },
    {
      id: 'rules',
      rank: 2,
      scoring: 'outcome',
      maxActions: 400,
      publicSeeds: 12,
      params: { opponent: 'rules', duplicateDeals: 20 },
    },
    {
      id: 'equity',
      rank: 3,
      scoring: 'outcome',
      maxActions: 400,
      publicSeeds: 12,
      params: { opponent: 'equity', duplicateDeals: 20 },
    },
  ]),
};

/**
 * The legal action strings, sorted.
 *
 * @param {import('./engine.js').HandState} hand
 * @returns {string[]}
 */
function legalFor(hand) {
  const legal = ['call', 'fold'];
  if (canRaise(hand)) legal.push('raise');
  return legal;
}

/**
 * Observation for a seat. Never includes the other seat's hole cards before
 * a showdown; the state's hidden deal lives in the match state only.
 *
 * @param {MatchState} state
 * @param {number} seat
 * @returns {Observation}
 */
function observeSeat(state, seat) {
  const hand = /** @type {import('./engine.js').HandState} */ (state.hand);
  const board = visibleBoard(hand);
  const pot = hand.put[0] + hand.put[1];
  const legal = legalFor(hand);
  const streetName = ['preflop', 'flop', 'turn', 'river'][hand.street];
  const lines = [];
  lines.push(
    `Heads-up limit hold'em, hand ${hand.index + 1} of ${TOTAL_HANDS} (deal ${Math.floor(hand.index / 2) + 1} of 20, played twice with seats swapped). You are seat ${seat}${seat === hand.dealer ? ' (dealer, small blind)' : ' (big blind)'}.`
  );
  lines.push(`Hand ${hand.index + 1} of ${TOTAL_HANDS} | running chips: you ${state.chips[seat] >= 0 ? '+' : ''}${state.chips[seat]}, opponent ${state.chips[1 - seat] >= 0 ? '+' : ''}${state.chips[1 - seat]} | match bb100 so far depends on completed hands.`);
  lines.push(`Your hole cards: ${cardsText(hand.hole[seat])}`);
  lines.push(
    hand.street === 0
      ? 'Board: (not yet dealt)'
      : `Board (${streetName}): ${cardsText(board)}`
  );
  const toCallNow = toCall(hand, seat);
  lines.push(
    `Pot: ${pot} | this street (${streetName}): bet level ${hand.bet}, ${hand.raises} of 4 bets used, you have put in ${hand.streetPut[seat]} this street and ${hand.put[seat]} this hand | to call: ${toCallNow}${toCallNow === 0 ? ' (check)' : ''}`
  );
  if (state.history.length > 0) {
    lines.push(`Earlier hands (${state.history.length}):`);
    for (const record of state.history) {
      let line = `  hand ${record.hand + 1}: ${record.reason}`;
      if (record.shown) {
        line += ` (seat 0 showed ${cardsText(record.shown[0])}, seat 1 showed ${cardsText(record.shown[1])})`;
      }
      lines.push(line);
    }
  } else {
    lines.push('Earlier hands: none yet.');
  }
  lines.push(`Legal actions (all listed): ${legal.join(', ')}.`);
  /** @type {HoldemData} */
  const data = {
    you: seat,
    hole: hand.hole[seat].slice(),
    board,
    street: hand.street,
    bet: hand.bet,
    raises: hand.raises,
    streetPut: hand.streetPut.slice(),
    put: hand.put.slice(),
    pot,
    toCall: toCallNow,
    canRaise: canRaise(hand),
    dealer: hand.dealer,
    handIndex: hand.index,
    dealIndex: Math.floor(hand.index / 2),
  };
  return { text: lines.join('\n'), data };
}

export const holdem = {
  spec,

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {MatchState}
   */
  reset(tier, seed) {
    return newMatch(tier.id, seed);
  },

  /**
   * @param {MatchState} state
   * @returns {number | null}
   */
  toAct(state) {
    return seatToAct(state);
  },

  /**
   * @param {MatchState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    return observeSeat(state, seat);
  },

  /**
   * @param {MatchState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    const hand = /** @type {import('./engine.js').HandState} */ (state.hand);
    void seat;
    return legalFor(hand);
  },

  /**
   * @param {MatchState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    const hand = /** @type {import('./engine.js').HandState} */ (state.hand);
    void seat;
    let s = String(text).trim();
    // Strip wrapping quotes/backticks.
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.toLowerCase();
    // Optional trailing chip amount ("call 2", "raise 4") is informational:
    // the engine applies the fixed-limit increment regardless.
    s = s.replace(/\s+\d+\s*$/, '');
    // Loose leading prose ("i fold", "action: raise") before the keyword.
    const match = /(?:^|\b)(fold|call|check|raise|bet)(?:\b|$)/.exec(s);
    if (!match) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as an action; use fold, call (or check), or raise (or bet)`,
      };
    }
    const word = match[1];
    if (word === 'fold') return { ok: true, action: 'fold' };
    if (word === 'call' || word === 'check') return { ok: true, action: 'call' };
    // raise / bet
    if (!canRaise(hand)) {
      return {
        ok: false,
        error: `the betting cap (4 bets) is reached on the ${['preflop', 'flop', 'turn', 'river'][hand.street]}; only call or fold remain`,
      };
    }
    return { ok: true, action: 'raise' };
  },

  /**
   * @param {MatchState} state
   * @param {number} seat
   * @param {string} action
   * @returns {MatchState}
   */
  step(state, seat, action) {
    const legal = this.legalActions(state, seat);
    if (!legal.includes(action)) {
      throw new GauntletRuleError(
        `action ${JSON.stringify(action)} is not legal for seat ${seat} (legal: ${legal.join(', ')})`
      );
    }
    const next = /** @type {MatchState} */ (JSON.parse(JSON.stringify(state)));
    applyAction(next, seat, /** @type {'fold' | 'call' | 'raise'} */ (action));
    return next;
  },

  /**
   * @param {MatchState} state
   * @returns {import('../../core/types.js').Outcome | null}
   */
  outcome(state) {
    if (state.hand !== null) return null;
    const result = matchOutcome(state);
    return result;
  },

  /**
   * Truncation scores the hands completed so far.
   *
   * @param {MatchState} state
   * @returns {import('../../core/types.js').Outcome}
   */
  truncate(state) {
    return truncateOutcome(state);
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    const kind = /** @type {'station' | 'rules' | 'equity'} */ (tier.params.opponent);
    return makeOpponent(kind, tier, seed, seat);
  },
};

/** @type {Game<MatchState>} */
export default holdem;
