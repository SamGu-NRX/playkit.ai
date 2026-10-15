/**
 * Heads-up fixed-limit Texas hold'em engine: match structure, hand state
 * machine and betting rules. Pure functions over JSON-serializable state —
 * no mutation, no `node:*` imports, every random choice comes from the
 * caller-supplied core RNG state stored inside the match state.
 *
 * Rules implemented (heads-up fixed limit):
 * - Blinds 1 (small, posted by the dealer/button) and 2 (big).
 * - Small bet 2 on the preflop and flop streets, big bet 4 on turn and
 *   river; at most four bets per street (the initial bet or blind counts as
 *   the first, so three raises after it).
 * - Stacks reset every hand: each seat has 100 chips available for the hand,
 *   which the bet cap can never exceed (worst case is 48 per hand), so
 *   all-in never occurs and pots always split evenly.
 * - One episode is a duplicate match of 20 deals, each dealt twice with the
 *   button swapped (40 hands): in hand 2k the deal's dealer posts the small
 *   blind; in hand 2k+1 the other seat has the button, so every seat plays
 *   its hole cards from both positions of the same board.
 *
 * @module
 */

import { fullDeck } from './cards.js';
import { evaluate } from './evaluator.js';
import { rngFromSeed, shuffle } from '../../core/rng.js';

/** @import { RngState } from '../../core/rng.js' */

export const SMALL_BET = 2;
export const BIG_BET = 4;
export const MAX_BETS_PER_STREET = 4;
export const SMALL_BLIND = 1;
export const BIG_BLIND = 2;
export const HAND_STACK = 100;
export const DEALS_PER_MATCH = 20;
export const TOTAL_HANDS = DEALS_PER_MATCH * 2;

export const STREET_NAMES = ['preflop', 'flop', 'turn', 'river'];

/**
 * @typedef {object} Deal
 * @property {number[]} dealerHole Two cards for the dealer seat.
 * @property {number[]} nonDealerHole Two cards for the other seat.
 * @property {number[]} board Five board cards.
 * @property {number} dealer Dealer seat for this deal.
 */

/**
 * @typedef {object} HandState
 * @property {number} index 0..39.
 * @property {number} dealer Dealer seat this hand.
 * @property {number[][]} hole Per-seat hole cards (mapped through the swap).
 * @property {number[]} board Five board cards (all dealt; reveal by street).
 * @property {number} revealed Board cards visible (0, 3, 4, 5).
 * @property {number} street 0 preflop, 1 flop, 2 turn, 3 river.
 * @property {number} bet Current street's bet level (2 preflop, else 0..).
 * @property {number} raises Bets this street so far (the blind is the first).
 * @property {number[]} streetPut Chips put in on the current street.
 * @property {number[]} put Chips put in this hand, per seat.
 * @property {boolean[]} acted Has each seat acted since the last bet?
 * @property {number} folded Seat that folded, or -1.
 */

/**
 * @typedef {object} MatchOutcomeResult
 * @property {number[]} normalized Per seat, sums to 1.
 * @property {number[]} raw Chip totals per seat.
 * @property {string} reason
 */

/**
 * @typedef {object} HandRecord
 * @property {number} hand
 * @property {number[]} delta Chip delta per seat for the hand.
 * @property {string} reason
 * @property {number[][] | null} shown Both seats' hole cards at a showdown, else null.
 * @property {string} [winnerName] Hand description at a showdown.
 * @property {string} [loserName] Hand description at a showdown.
 */

/**
 * @typedef {object} MatchState
 * @property {RngState} rng Episode RNG state (advanced only by shuffles).
 * @property {number} dealIndex 0..19.
 * @property {number} handIndex 0..39.
 * @property {Deal | null} deal Cards for the current deal.
 * @property {HandState | null} hand Active hand, or null when over.
 * @property {number[]} chips Running chip totals.
 * @property {HandRecord[]} history Completed hands, in order.
 */

/**
 * @typedef {object} EngineAction
 * @property {'fold' | 'call' | 'raise'} kind
 */

/**
 * Deal the next deal's cards from the match RNG.
 *
 * @param {MatchState} state
 * @returns {Deal}
 */
function nextDeal(state) {
  const { value: deck, state: rng } = shuffle(state.rng, fullDeck());
  state.rng = rng;
  const dealer = state.dealIndex % 2;
  return {
    dealerHole: [deck[0], deck[1]],
    nonDealerHole: [deck[2], deck[3]],
    board: [deck[4], deck[5], deck[6], deck[7], deck[8]],
    dealer,
  };
}

/**
 * Start a fresh hand (2k: original orientation; 2k+1: seats swapped).
 * Advances dealIndex and reshuffles when entering a new deal.
 *
 * @param {MatchState} state
 * @param {number} handIndex
 * @returns {void}
 */
function startHand(state, handIndex) {
  state.handIndex = handIndex;
  if (state.hand === null || state.hand.index % 2 === 1) {
    // Entering a new deal (first hand of the match, or after a swapped hand).
    state.dealIndex = handIndex / 2;
    state.deal = nextDeal(state);
  }
  const deal = /** @type {Deal} */ (state.deal);
  const swapped = handIndex % 2 === 1;
  const dealer = swapped ? 1 - deal.dealer : deal.dealer;
  const nonDealer = 1 - dealer;
  const dealerHole = swapped ? deal.nonDealerHole : deal.dealerHole;
  const nonDealerHole = swapped ? deal.dealerHole : deal.nonDealerHole;

  // Preflop: dealer posts the small blind, the other seat the big blind.
  /** @type {HandState} */
  const hand = {
    index: handIndex,
    dealer,
    hole: [new Array(2), new Array(2)],
    board: deal.board.slice(),
    revealed: 0,
    street: 0,
    bet: BIG_BLIND,
    raises: 1,
    streetPut: [0, 0],
    put: [0, 0],
    acted: [false, false],
    folded: -1,
  };
  hand.hole[dealer] = dealerHole.slice();
  hand.hole[nonDealer] = nonDealerHole.slice();
  hand.streetPut[dealer] = SMALL_BLIND;
  hand.streetPut[nonDealer] = BIG_BLIND;
  hand.put[dealer] = SMALL_BLIND;
  hand.put[nonDealer] = BIG_BLIND;
  state.hand = hand;
}

/**
 * Create a fresh match state for a tier and seed. Deterministic in
 * (tierId, seed): the deck shuffles come from the core sfc32 stream seeded
 * by cyrb128 of a stable string, and every later transition is pure.
 *
 * @param {string} tierId
 * @param {string} seed
 * @returns {MatchState}
 */
export function newMatch(tierId, seed) {
  /** @type {MatchState} */
  const state = {
    rng: rngFromSeed(`holdem/${tierId}/${seed}`),
    dealIndex: 0,
    handIndex: 0,
    deal: null,
    hand: null,
    chips: [0, 0],
    history: [],
  };
  startHand(state, 0);
  return state;
}

/**
 * The seat to act, or null when the match is over.
 *
 * @param {MatchState} state
 * @returns {number | null}
 */
export function seatToAct(state) {
  const hand = state.hand;
  if (!hand) return null;
  // Preflop the dealer (small blind) acts first; postflop the non-dealer.
  const first = hand.street === 0 ? hand.dealer : 1 - hand.dealer;
  if (hand.acted[first]) return 1 - first;
  return first;
}

/**
 * Whether a raise (bet) is still available on the current street.
 *
 * @param {HandState} hand
 * @returns {boolean}
 */
export function canRaise(hand) {
  return hand.raises < MAX_BETS_PER_STREET;
}

/**
 * Raise increment on the current street: small bet on preflop and flop,
 * big bet on turn and river.
 *
 * @param {HandState} hand
 * @returns {number}
 */
export function raiseIncrement(hand) {
  return hand.street <= 1 ? SMALL_BET : BIG_BET;
}

/**
 * Chips the seat must add to call on the current street (0 = check).
 *
 * @param {HandState} hand
 * @param {number} seat
 * @returns {number}
 */
export function toCall(hand, seat) {
  return hand.bet - hand.streetPut[seat];
}

/**
 * Apply one legal action to the hand and run the state machine forward:
 * street transitions, showdown resolution, and advancing to the next hand
 * (or ending the match). Mutates `state` in place; callers clone the match
 * state first to keep step() pure.
 *
 * @param {MatchState} state
 * @param {number} seat
 * @param {'fold' | 'call' | 'raise'} kind
 * @returns {void}
 */
export function applyAction(state, seat, kind) {
  const hand = /** @type {HandState} */ (state.hand);
  if (kind === 'fold') {
    hand.folded = seat;
    finishHand(
      state,
      1 - seat,
      `hand ${hand.index + 1}: seat ${1 - seat} won ${pot(hand)} chips when seat ${seat} folded on the ${STREET_NAMES[hand.street]}`
    );
    return;
  }
  if (kind === 'raise') {
    // A raise lifts the bet level by one increment and tops the raiser up to
    // that new level (a preflop small-blind raise to one bet over the blind
    // adds 3, not 2).
    const newBet = hand.bet + raiseIncrement(hand);
    const add = newBet - hand.streetPut[seat];
    hand.streetPut[seat] += add;
    hand.put[seat] += add;
    hand.bet = newBet;
    hand.raises += 1;
    hand.acted[seat] = true;
    hand.acted[1 - seat] = false;
    return;
  }
  // call (also check when nothing to call).
  const amount = toCall(hand, seat);
  hand.streetPut[seat] += amount;
  hand.put[seat] += amount;
  hand.acted[seat] = true;

  // Round complete when both seats have acted and matched bets.
  if (hand.acted[0] && hand.acted[1] && hand.streetPut[0] === hand.streetPut[1]) {
    if (hand.street === 3) {
      showdown(state);
      return;
    }
    advanceStreet(hand);
  }
}

/**
 * @param {HandState} hand
 * @returns {number}
 */
function pot(hand) {
  return hand.put[0] + hand.put[1];
}

/**
 * @param {HandState} hand
 * @returns {void}
 */
function advanceStreet(hand) {
  hand.street += 1;
  hand.revealed = hand.street === 1 ? 3 : hand.street === 2 ? 4 : 5;
  hand.bet = 0;
  hand.raises = 0;
  hand.streetPut = [0, 0];
  hand.acted = [false, false];
}

/**
 * Resolve a showdown: compare seven-card hands, award the pot (splitting on
 * an exact tie), record the shown cards, and advance the match.
 *
 * @param {MatchState} state
 * @returns {void}
 */
function showdown(state) {
  const hand = /** @type {HandState} */ (state.hand);
  const board = visibleBoard(hand);
  const cards0 = [hand.hole[0][0], hand.hole[0][1], ...board];
  const cards1 = [hand.hole[1][0], hand.hole[1][1], ...board];
  const best0 = evaluate(cards0);
  const best1 = evaluate(cards1);
  const total = pot(hand);
  if (best0.value === best1.value) {
    finishHand(state, null, `hand ${hand.index + 1} split the pot of ${total} at showdown: both hold ${best0.name}`, {
      shown: [hand.hole[0].slice(), hand.hole[1].slice()],
      winnerName: best0.name,
      loserName: best1.name,
    });
    return;
  }
  const winner = best0.value > best1.value ? 0 : 1;
  const best = winner === 0 ? best0 : best1;
  const other = winner === 0 ? best1 : best0;
  finishHand(
    state,
    winner,
    `hand ${hand.index + 1} went to showdown and seat ${winner} won ${total} chips with ${best.name} against ${other.name}`,
    {
      shown: [hand.hole[0].slice(), hand.hole[1].slice()],
      winnerName: best.name,
      loserName: other.name,
    }
  );
}

/**
 * Complete the current hand: settle chips, record history, and either start
 * the next hand or close the match.
 *
 * @param {MatchState} state
 * @param {number | null} winner Winning seat, or null for a split pot.
 * @param {string} reason
 * @param {{ shown?: number[][], winnerName?: string, loserName?: string }} [extra]
 * @returns {void}
 */
function finishHand(state, winner, reason, extra = {}) {
  const hand = /** @type {HandState} */ (state.hand);
  /** @type {number[]} */
  const delta = [0, 0];
  if (winner === null) {
    // Split pot: contributions are always equal at a showdown.
    delta[0] = pot(hand) / 2 - hand.put[0];
    delta[1] = pot(hand) / 2 - hand.put[1];
  } else {
    delta[winner] = hand.put[1 - winner];
    delta[1 - winner] = -hand.put[1 - winner];
  }
  state.chips[0] += delta[0];
  state.chips[1] += delta[1];
  /** @type {HandRecord} */
  const record = {
    hand: hand.index,
    delta,
    reason,
    shown: extra.shown ?? null,
  };
  if (extra.winnerName !== undefined) record.winnerName = extra.winnerName;
  if (extra.loserName !== undefined) record.loserName = extra.loserName;
  state.history.push(record);
  if (hand.index + 1 >= TOTAL_HANDS) {
    state.hand = null;
    return;
  }
  startHand(state, hand.index + 1);
}

/**
 * Board cards visible on the current street.
 *
 * @param {HandState} hand
 * @returns {number[]}
 */
export function visibleBoard(hand) {
  return hand.board.slice(0, hand.revealed);
}

/**
 * Normalized score from a chip margin over completed hands:
 * normalized = 1 / (1 + exp(-bb100 / 50)), where bb100 is the seat's big
 * blinds won per 100 hands. Antisymmetric: the seats' scores sum to 1, so
 * 0.5 is break-even.
 *
 * @param {number} chipMargin Chips won minus chips lost for the seat.
 * @param {number} handsCompleted
 * @returns {number}
 */
export function normalizedFromChips(chipMargin, handsCompleted) {
  const hands = handsCompleted > 0 ? handsCompleted : 1;
  const bb100 = ((chipMargin / BIG_BLIND) * 100) / hands;
  return 1 / (1 + Math.exp(-bb100 / 50));
}

/**
 * Match outcome once all hands are complete (hand === null).
 *
 * @param {MatchState} state
 * @returns {import('./engine.js').MatchOutcomeResult}
 */
export function matchOutcome(state) {
  const hands = state.history.length;
  const norm0 = normalizedFromChips(state.chips[0] - state.chips[1], hands);
  return {
    normalized: [norm0, 1 - norm0],
    raw: [state.chips[0], state.chips[1]],
    reason: `duplicate match complete: ${DEALS_PER_MATCH} deals, ${hands} hands, seat 0 finished ${signed(state.chips[0])} chips (${signed(state.chips[1])} for seat 1)`,
  };
}

/**
 * Truncation outcome: score the hands completed so far.
 *
 * @param {MatchState} state
 * @returns {import('./engine.js').MatchOutcomeResult}
 */
export function truncateOutcome(state) {
  const hands = state.history.length;
  const norm0 = normalizedFromChips(state.chips[0] - state.chips[1], hands);
  return {
    normalized: [norm0, 1 - norm0],
    raw: [state.chips[0], state.chips[1]],
    reason: `budget exhausted mid-match: ${hands} of ${TOTAL_HANDS} hands completed, seat 0 at ${signed(state.chips[0])} chips; completed hands scored, the hand in progress discarded`,
  };
}

/**
 * @param {number} n
 * @returns {string}
 */
function signed(n) {
  return n >= 0 ? `+${n}` : String(n);
}
