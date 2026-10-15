/**
 * Fixed opponent policies for the hold'em tiers, ranked: `station` (always
 * calls), `rules` (preflop chart + made-hand strength), `equity` (Monte
 * Carlo equity against a uniform range, fixed seeded sample count). All are
 * deterministic: any randomness comes from streams seeded by the episode
 * seed and decision counters, never the clock or Math.random. No `node:*`
 * imports.
 *
 * @module
 */

import { fullDeck } from './cards.js';
import { evaluate } from './evaluator.js';
import { streamFromSeed } from '../../core/rng.js';
import { chenScore } from './strength.js';

/** @import { Agent, TierSpec } from '../../core/types.js' */

/** Fixed Monte Carlo sample count for the equity bot (a tier-facing constant: fixed per the spec). */
export const EQUITY_SAMPLES = 200;

/**
 * The structured part of an observation. Both bots and baselines read this.
 *
 * @typedef {object} HoldemData
 * @property {number} you
 * @property {number[]} hole The viewer's hole cards.
 * @property {number[]} board Visible board cards.
 * @property {number} street 0..3.
 * @property {number} bet Current bet level this street.
 * @property {number} raises Bets this street.
 * @property {number[]} streetPut
 * @property {number[]} put Total contributed this hand.
 * @property {number} pot
 * @property {number} toCall Chips needed to call (0 = check).
 * @property {boolean} canRaise Raise still available under the cap?
 * @property {number} dealer
 * @property {number} handIndex
 * @property {number} dealIndex
 */

/**
 * Monte Carlo equity of `hole` against one uniform random opponent hand,
 * given the visible board, using the supplied seeded stream. Draws opponent
 * cards and the missing board cards by partial Fisher-Yates from the unseen
 * deck.
 *
 * @param {readonly number[]} hole
 * @param {readonly number[]} board Visible board cards.
 * @param {number} boardSize Full board size (5).
 * @param {number} samples Fixed sample count.
 * @param {import('../../core/rng.js').RngStream} stream Seeded stream.
 * @returns {number} Win probability in [0, 1], ties counted as one half.
 */
export function monteCarloEquity(hole, board, boardSize, samples, stream) {
  const seen = new Set(hole);
  for (const c of board) seen.add(c);
  const unseen = fullDeck().filter((c) => !seen.has(c));
  const missing = boardSize - board.length;
  const need = 2 + missing;
  const wins = [0, 0];
  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw `need` cards from the unseen deck.
    const n = unseen.length;
    for (let i = 0; i < need; i++) {
      const j = stream.nextInt(i, n - 1);
      const tmp = unseen[i];
      unseen[i] = unseen[j];
      unseen[j] = tmp;
    }
    const oppHole = [unseen[0], unseen[1]];
    const fullBoard = board.slice();
    for (let i = 0; i < missing; i++) fullBoard.push(unseen[2 + i]);
    const mine = evaluate([hole[0], hole[1], ...fullBoard]).value;
    const theirs = evaluate([oppHole[0], oppHole[1], ...fullBoard]).value;
    if (mine > theirs) wins[0] += 1;
    else if (mine === theirs) {
      wins[0] += 0.5;
      wins[1] += 0.5;
    } else wins[1] += 1;
  }
  return wins[0] / samples;
}

/**
 * The equity policy, shared by the `equity` tier opponent and the `engine`
 * baseline: raise on high equity, otherwise call when the price is right
 * against the pot odds, otherwise fold.
 *
 * @param {HoldemData} data
 * @param {number} equity
 * @returns {'fold' | 'call' | 'raise'}
 */
export function equityPolicy(data, equity) {
  const potOdds = data.toCall > 0 ? data.toCall / (data.pot + data.toCall) : 0;
  if (data.canRaise && equity >= 0.7) return 'raise';
  // Price protection: folding big streets to tiny prices is worse than
  // calling, so add a small slack rather than exact pot odds.
  if (data.toCall === 0 || equity >= potOdds + 0.02) return 'call';
  return 'fold';
}

/**
 * @param {HoldemData} data
 * @returns {'fold' | 'call' | 'raise'}
 */
function stationAction(data) {
  void data;
  return 'call';
}

/**
 * The `rules` bot: a preflop hand-strength chart (Chen score thresholds,
 * adjusted for position and for facing raises) and postflop made-hand
 * strength from the evaluator.
 *
 * @param {HoldemData} data
 * @returns {'fold' | 'call' | 'raise'}
 */
function rulesAction(data) {
  if (data.street === 0) {
    const score = chenScore(data.hole);
    const onButton = data.you === data.dealer;
    const facingRaises = data.raises >= 2;
    if (facingRaises) {
      if (data.canRaise && score >= 10) return 'raise';
      if (score >= 7) return 'call';
      return 'fold';
    }
    // Unraised (only blinds in): open-raise strong, play most hands.
    if (data.canRaise && score >= 9) return 'raise';
    if (score >= (onButton ? 4 : 5)) return 'call';
    return 'fold';
  }
  // Postflop: made-hand strength.
  const made = evaluate([...data.hole, ...data.board]);
  const cat = made.category;
  if (cat >= 6) {
    // Full house or better: always bet/raise.
    return data.canRaise ? 'raise' : 'call';
  }
  if (cat >= 4) {
    // Straight or flush: bet, but give up raising into a capped street.
    return data.canRaise && data.raises < 3 ? 'raise' : 'call';
  }
  if (cat >= 2) {
    // Two pair or trips: one bet per street, then call down.
    return data.canRaise && data.raises < 2 ? 'raise' : 'call';
  }
  if (cat === 1) {
    // One pair: call small prices, fold big raises with a weak pair.
    if (data.toCall === 0) return 'call';
    if (data.raises >= 3) return 'fold';
    return 'call';
  }
  // High card: check when possible, otherwise fold.
  return data.toCall === 0 ? 'call' : 'fold';
}

/**
 * Map an internal decision to an action name. 'check-call' and 'call' are
 * the same canonical action (call also means check); kept explicit in the
 * rules bot above to document intent.
 *
 * @param {'fold' | 'call' | 'raise' | 'check-call'} kind
 * @returns {'fold' | 'call' | 'raise'}
 */
function normalize(kind) {
  return kind === 'check-call' ? 'call' : kind;
}

/**
 * The `equity` bot: Monte Carlo equity against a uniform range with a fixed,
 * seeded sample count, then the shared equity policy.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} seat
 * @param {HoldemData} data
 * @param {number} decisionCount
 * @returns {'fold' | 'call' | 'raise'}
 */
function equityAction(tier, seed, seat, data, decisionCount) {
  const streamKey = `${tier.id}/${seed}/opp/${seat}/hand${data.handIndex}/street${data.street}/bets${data.raises}/decision${decisionCount}`;
  const stream = streamFromSeed(streamKey);
  const equity = monteCarloEquity(data.hole, data.board, 5, EQUITY_SAMPLES, stream);
  return equityPolicy(data, equity);
}

/**
 * Build the opponent Agent for a tier.
 *
 * @param {'station' | 'rules' | 'equity'} kind
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} seat
 * @returns {Agent}
 */
export function makeOpponent(kind, tier, seed, seat) {
  const id = `${kind}-opponent`;
  return {
    id,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const data = /** @type {HoldemData} */ (ctx.observation.data);
      let kind2;
      if (kind === 'station') kind2 = stationAction(data);
      else if (kind === 'rules') kind2 = rulesAction(data);
      else kind2 = equityAction(tier, seed, seat, data, ctx.turn);
      const action = normalize(/** @type {'fold' | 'call' | 'raise' | 'check-call'} */ (kind2));
      // Guard: a fixed bot must never produce an illegal action.
      if (action === 'raise' && !data.canRaise) return { text: 'call' };
      return { text: action };
    },
  };
}
