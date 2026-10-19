/**
 * Correctness tests for the hold'em game: evaluator hand cases, the two
 * exhaustive enumerations against Wikipedia's published totals, betting
 * rules, duplicate pairing, hidden information, determinism, conformance and
 * trajectory verification. Run with `node --test` from `gauntlet/`.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cardName, parseCard } from './cards.js';
import { evaluate, categorize, CATEGORY_DIVISOR } from './evaluator.js';
import { applyAction, canRaise, matchOutcome, newMatch, normalizedFromChips, seatToAct, toCall, TOTAL_HANDS, truncateOutcome } from './engine.js';
import { holdem, GAME_ID } from './index.js';
import { makeBaseline, parseHandsCompleted } from './baselines.js';
import { chenScore } from './strength.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { publicSeed } from '../../core/seeds.js';

/** @import { MatchState } from './engine.js' */

/**
 * @param {string[]} names
 * @returns {number[]}
 */
function cards(names) {
  return names.map((n) => {
    const card = parseCard(n);
    assert(card !== null, `bad test card ${n}`);
    return /** @type {number} */ (card);
  });
}

/** @param {number[]} cs */
const cat = (cs) => evaluate(cs).category;

/** @param {number[]} cs */
const val = (cs) => evaluate(cs).value;

test('card naming round trips', () => {
  assert.equal(cardName(parseCard('As') ?? -1), 'As');
  assert.equal(cardName(parseCard('td') ?? -1), 'Td');
  assert.equal(parseCard('zz'), null);
});

test('evaluator hand-built cases rank correctly', () => {
  const aceHighFlush = cards(['As', 'Ks', '9s', '5s', '2s', '3d', '4c']);
  const kingFlush = cards(['Ks', 'Qs', '9s', '5s', '2s', '3d', '4c']);
  const quads = cards(['7c', '7d', '7h', '7s', '2s', '3d', '4c']);
  const quadsLowKicker = cards(['7c', '7d', '7h', '7s', '2d', '3d', '4c']);
  const quadBetterKicker = cards(['7c', '7d', '7h', '7s', '2d', '3d', '5c']);
  const boat = cards(['7c', '7d', '7h', '2c', '2d', 'As', 'Kc']);
  const trips = cards(['7c', '7d', '7h', '2c', '3d', 'As', 'Kc']);
  const straight = cards(['9c', '8d', '7h', '6s', '5c', '2d', '3c']);
  const wheel = cards(['Ac', '2d', '3h', '4s', '5c', 'Kd', 'Qc']);
  const sixHighStraight = cards(['6c', '5d', '4h', '3s', '2c', 'Kd', 'Qc']);
  const twoPairAcesUpKingKicker = cards(['Ac', 'Ad', '9h', '9s', '2c', '3d', 'Kc']);
  const twoPairAcesUpThirdPairKicker = cards(['Ac', 'Ad', '9h', '9s', '2c', '2d', '3c']);
  const pair = cards(['Ac', 'Ad', '9h', '4s', '2c', '3d', 'Kc']);
  const highCard = cards(['Ac', 'Kd', '9h', '4s', '2c', '3d', '6c']);
  const straightFlush = cards(['9s', '8s', '7s', '6s', '5s', '2d', '3c']);
  const royalFlush = cards(['Ts', 'Js', 'Qs', 'Ks', 'As', '2d', '3c']);

  assert.equal(cat(royalFlush), 8);
  assert.ok(val(straightFlush) < val(royalFlush), 'royal flush is the top straight flush');
  assert.ok(val(straightFlush) > val(quads), 'straight flush beats quads');
  assert.ok(val(quads) > val(boat), 'quads beats full house');
  assert.ok(val(quadBetterKicker) > val(quadsLowKicker), 'quad kickers break ties');
  assert.ok(val(boat) > val(trips) && val(boat) > val(aceHighFlush), 'full house beats trips and flush');
  assert.ok(val(aceHighFlush) > val(kingFlush), 'flush kickers break ties');
  assert.ok(val(aceHighFlush) > val(straight), 'flush beats straight');
  assert.ok(val(straight) > val(trips), 'straight beats trips');
  assert.ok(val(wheel) < val(sixHighStraight), 'the wheel is the lowest straight');
  assert.ok(val(twoPairAcesUpKingKicker) > val(pair), 'two pair beats pair');
  assert.ok(
    val(twoPairAcesUpKingKicker) > val(twoPairAcesUpThirdPairKicker),
    'AA99 with a king beats AA99 whose fifth card is a deuce-deuce third pair'
  );
  assert.ok(val(pair) > val(highCard), 'pair beats high card');
});

test('evaluator split-pot cases produce equal values', () => {
  const board = cards(['Kc', 'Qd', '9h', '5s', '2c']);
  const p0 = evaluate([...cards(['Ac', 'Ad']), ...board]);
  const p1 = evaluate([...cards(['Ah', 'As']), ...board]);
  assert.equal(p0.value, p1.value);
  assert.equal(p0.name, p1.name);
});

test('evaluator: high-card hands compare all five kickers', () => {
  // Board Ac Kd Qh 4s 2c: 9-8 in the hole plays A K Q 9 8, 7-6 plays
  // A K Q 7 6 — only the fourth and fifth kickers differ.
  const board = cards(['Ac', 'Kd', 'Qh', '4s', '2c']);
  const ninetyEight = evaluate([...cards(['9d', '8c']), ...board]);
  const seventySix = evaluate([...cards(['7d', '6c']), ...board]);
  assert.ok(ninetyEight.value > seventySix.value, 'A K Q 9 8 beats A K Q 7 6');
  assert.equal(ninetyEight.category, 0);
  assert.equal(seventySix.category, 0);

  // Board Ac Kd Qh Js 4c: four shared kickers, the fifth decides.
  const broadwayBoard = cards(['Ac', 'Kd', 'Qh', 'Js', '4c']);
  const aceHigh98 = evaluate([...cards(['9d', '8c']), ...broadwayBoard]);
  const aceHigh87 = evaluate([...cards(['8d', '7c']), ...broadwayBoard]);
  assert.ok(aceHigh98.value > aceHigh87.value, 'A K Q J 9 beats A K Q J 8');

  // Equal ranks still split regardless of suits (no flush available).
  const suitsA = evaluate([...cards(['9d', '8c']), ...board]);
  const suitsB = evaluate([...cards(['9h', '8s']), ...board]);
  assert.equal(suitsA.value, suitsB.value, 'equal ranks split regardless of suits');
});

test('chenScore matches the documented Chen mapping', () => {
  // Broadway high cards and the pair minimum were already correct.
  assert.equal(chenScore(cards(['As', 'Ad'])), 20);
  assert.equal(chenScore(cards(['Th', 'Tc'])), 10);
  assert.equal(chenScore(cards(['Ah', 'Kd'])), 10);
  assert.equal(chenScore(cards(['Ah', 'Kh'])), 12);
  assert.equal(chenScore(cards(['2d', '2c'])), 5);
  // Sub-broadway high cards score face value / 2 (nine 4.5, deuce 1).
  assert.equal(chenScore(cards(['9d', '9c'])), 9);
  assert.equal(chenScore(cards(['9d', '8c'])), 5);
  assert.equal(chenScore(cards(['6d', '5c'])), 3);
  assert.equal(chenScore(cards(['7d', '2c'])), -2);
  assert.equal(chenScore(cards(['3d', '2c'])), 2);
});

test('parseHandsCompleted reads the hands count out of outcome reasons', () => {
  assert.equal(
    parseHandsCompleted(
      'budget exhausted mid-match: 17 of 40 hands completed, seat 0 at -2 chips; completed hands scored, the hand in progress discarded'
    ),
    17,
    'a truncated outcome counts the hands actually completed'
  );
  assert.equal(
    parseHandsCompleted('duplicate match complete: 20 deals, 40 hands, seat 0 finished +12 chips (+12 for seat 1)'),
    40
  );
  assert.equal(parseHandsCompleted(''), 40, 'unparseable reasons fall back to the full match');
});

test('evaluator category counts over all 2,598,960 five-card hands match Wikipedia', () => {
  // Wikipedia, "Poker probability" (5-card hands): high card 1,302,540;
  // one pair 1,098,240; two pair 123,552; three of a kind 54,912;
  // straight 10,200; flush 5,108; full house 3,744; four of a kind 624;
  // straight flush 40. Source: https://en.wikipedia.org/wiki/Poker_probability
  const expected = [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40];
  /** @type {number[]} */
  const tally = new Array(9).fill(0);
  const counts = new Int8Array(13);
  const masks = new Int32Array(4);
  let rankMask = 0;
  /** @param {number} card */
  const inc = (card) => {
    const r = card >> 2;
    const bit = 1 << r;
    counts[r] += 1;
    rankMask |= bit;
    masks[card & 3] |= bit;
    maskRanks[card & 3][r] += 1;
  };
  /** @param {number} card */
  const dec = (card) => {
    const r = card >> 2;
    counts[r] -= 1;
    if (counts[r] === 0) rankMask &= ~(1 << r);
    const s = card & 3;
    maskRanks[s][r] -= 1;
    if (maskRanks[s][r] === 0) masks[s] &= ~(1 << r);
  };
  /** @type {Int8Array[]} */
  const maskRanks = [new Int8Array(13), new Int8Array(13), new Int8Array(13), new Int8Array(13)];
  for (let a = 0; a < 48; a++) {
    inc(a);
    for (let b = a + 1; b < 49; b++) {
      inc(b);
      for (let c = b + 1; c < 50; c++) {
        inc(c);
        for (let d = c + 1; d < 51; d++) {
          inc(d);
          for (let e = d + 1; e < 52; e++) {
            inc(e);
            tally[Math.floor(categorize(rankMask, masks, counts) / CATEGORY_DIVISOR)] += 1;
            dec(e);
          }
          dec(d);
        }
        dec(c);
      }
      dec(b);
    }
    dec(a);
  }
  assert.deepEqual(tally, expected);
});

test('evaluator category counts over all 133,784,560 seven-card hands match Wikipedia', () => {
  // Wikipedia, "Poker probability" (7-card hands): high card 23,294,460;
  // one pair 58,627,800; two pair 31,433,400; three of a kind 6,461,620;
  // straight 6,180,020; flush 4,047,644; full house 3,473,184;
  // four of a kind 224,848; straight flush 41,584. Note: older copies of
  // Wikipedia's table list flush as 4,047,642, which leaves the nine
  // frequencies summing to 133,784,558 — two short of C(52,7) = 133,784,560.
  // 4,047,644 is the correct count (independent enumerations and the
  // corrected current table agree).
  // Source: https://en.wikipedia.org/wiki/Poker_probability
  const expected = [23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584];
  /** @type {number[]} */
  const tally = new Array(9).fill(0);
  const counts = new Int8Array(13);
  const masks = new Int32Array(4);
  let rankMask = 0;
  /** @type {Int8Array[]} */
  const maskRanks = [new Int8Array(13), new Int8Array(13), new Int8Array(13), new Int8Array(13)];
  /** @param {number} card */
  const inc = (card) => {
    const r = card >> 2;
    const bit = 1 << r;
    counts[r] += 1;
    rankMask |= bit;
    masks[card & 3] |= bit;
    maskRanks[card & 3][r] += 1;
  };
  /** @param {number} card */
  const dec = (card) => {
    const r = card >> 2;
    counts[r] -= 1;
    if (counts[r] === 0) rankMask &= ~(1 << r);
    const s = card & 3;
    maskRanks[s][r] -= 1;
    if (maskRanks[s][r] === 0) masks[s] &= ~(1 << r);
  };
  const startedAt = Date.now();
  for (let c0 = 0; c0 < 46; c0++) {
    inc(c0);
    for (let c1 = c0 + 1; c1 < 47; c1++) {
      inc(c1);
      for (let c2 = c1 + 1; c2 < 48; c2++) {
        inc(c2);
        for (let c3 = c2 + 1; c3 < 49; c3++) {
          inc(c3);
          for (let c4 = c3 + 1; c4 < 50; c4++) {
            inc(c4);
            for (let c5 = c4 + 1; c5 < 51; c5++) {
              inc(c5);
              for (let c6 = c5 + 1; c6 < 52; c6++) {
                inc(c6);
                tally[Math.floor(categorize(rankMask, masks, counts) / CATEGORY_DIVISOR)] += 1;
                dec(c6);
              }
              dec(c5);
            }
            dec(c4);
          }
          dec(c3);
        }
        dec(c2);
      }
      dec(c1);
    }
    dec(c0);
  }
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(tally, expected);
  console.log(`7-card enumeration: 133,784,560 hands evaluated in ${elapsedMs} ms`);
});

/** @param {MatchState} m @returns {NonNullable<MatchState['hand']>} */
const handOf = (m) => /** @type {NonNullable<MatchState['hand']>} */ (m.hand);

test('betting: blinds, order of play, and the big blind option', () => {
  const state = newMatch('station', 'betting-test');
  const hand = /** @type {NonNullable<MatchState['hand']>} */ (state.hand);
  assert.equal(hand.dealer, 0, 'deal 0 dealer is seat 0');
  assert.deepEqual(hand.streetPut, [1, 2], 'dealer posts the small blind');
  assert.equal(hand.bet, 2);
  assert.equal(hand.raises, 1);
  assert.equal(seatToAct(state), 0, 'dealer acts first preflop');
  assert.deepEqual(holdem.legalActions(state, 0), ['call', 'fold', 'raise']);

  // Dealer completes: the big blind now has the option.
  let next = holdem.step(state, 0, 'call');
  assert.deepEqual(handOf(next).streetPut, [2, 2]);
  assert.equal(seatToAct(next), 1, 'big blind has the option');
  // Big blind checks: round ends, flop arrives, non-dealer acts first.
  next = holdem.step(next, 1, 'call');
  assert.equal(handOf(next).street, 1);
  assert.equal(handOf(next).revealed, 3);
  assert.equal(seatToAct(next), 1, 'non-dealer acts first postflop');
  assert.equal(handOf(next).bet, 0);
  assert.equal(toCall(handOf(next), 1), 0);
});

test('betting: the four-bet cap blocks the fifth raise', () => {
  const state = newMatch('station', 'cap-test');
  let s = state;
  /** @returns {NonNullable<MatchState['hand']>} */
  const hand = () => /** @type {NonNullable<MatchState['hand']>} */ (s.hand);
  // Preflop: the blind is bet 1; three raises reach the cap.
  s = holdem.step(s, 0, 'raise');
  s = holdem.step(s, 1, 'raise');
  s = holdem.step(s, 0, 'raise');
  assert.equal(hand().raises, 4, 'blind + three raises = four bets');
  assert.equal(canRaise(hand()), false, 'cap reached');
  assert.deepEqual(holdem.legalActions(s, 1), ['call', 'fold'], 'raise is not legal at the cap');
  const parsed = holdem.parseAction(s, 1, 'raise');
  assert.equal(parsed.ok, false, 'parseAction rejects raise at the cap');
  assert.deepEqual(hand().streetPut, [8, 6], 'small blind has raised to the 8 level, big blind to 6');
  // Call ends the street; the cap resets per street.
  const s2 = holdem.step(s, 1, 'call');
  assert.equal(handOf(s2).street, 1);
  assert.deepEqual(handOf(s2).streetPut, [0, 0], 'the street advance clears street bets');
  assert.equal(canRaise(handOf(s2)), true, 'cap resets per street');
  // Flop: four small bets of 2 reach the cap again.
  let s3 = holdem.step(s2, 1, 'raise');
  s3 = holdem.step(s3, 0, 'raise');
  s3 = holdem.step(s3, 1, 'raise');
  s3 = holdem.step(s3, 0, 'raise');
  assert.equal(canRaise(handOf(s3)), false, 'flop cap reached after four small bets');
  assert.deepEqual(handOf(s3).streetPut, [8, 6]);
});

test('betting: street transitions and turn/river big bets', () => {
  const state = newMatch('station', 'streets-test');
  let s = holdem.step(state, 0, 'call');
  s = holdem.step(s, 1, 'call'); // flop
  assert.equal(handOf(s).street, 1);
  s = holdem.step(s, 1, 'call'); // non-dealer first postflop
  s = holdem.step(s, 0, 'call'); // turn
  assert.equal(handOf(s).street, 2);
  assert.equal(handOf(s).revealed, 4);
  s = holdem.step(s, 1, 'raise'); // turn bet is a big bet of 4
  assert.equal(handOf(s).bet, 4);
  assert.deepEqual(handOf(s).streetPut, [0, 4]);
  s = holdem.step(s, 0, 'call'); // river
  assert.equal(handOf(s).street, 3);
  assert.equal(handOf(s).revealed, 5);
  s = holdem.step(s, 1, 'raise'); // river bet 4
  s = holdem.step(s, 0, 'raise'); // raise to 8
  assert.equal(handOf(s).raises, 2);
  assert.deepEqual(handOf(s).streetPut, [8, 4]);
  const s2 = holdem.step(s, 1, 'call'); // showdown
  assert.equal(s2.history.length, 1, 'the river call resolves the hand');
  assert.ok(s2.history[0].shown !== null, 'showdown records shown cards');
  assert.equal(s2.history[0].hand, 0);
  assert.equal(handOf(s2).index, 1, 'the match advances to hand 2');
});

test('duplicate pairing: each deal is played twice with seats swapped', () => {
  const m = newMatch('station', 'duplicate-test');
  /** @type {{ board: number[], hole: number[][] }[]} */
  const seen = [];
  while (m.hand !== null) {
    seen.push({ board: m.hand.board.slice(), hole: m.hand.hole.map((h) => h.slice()) });
    applyAction(m, /** @type {number} */ (seatToAct(m)), 'fold');
  }
  assert.equal(seen.length, TOTAL_HANDS);
  for (let deal = 0; deal < 20; deal++) {
    const a = seen[deal * 2];
    const b = seen[deal * 2 + 1];
    assert.deepEqual(a.board, b.board, `deal ${deal} shares its board between the two plays`);
    // The duplicate design keeps each seat's hole cards and swaps the
    // button: every seat plays its cards from both positions.
    assert.deepEqual(
      [a.hole[0].slice().sort((x, y) => x - y), a.hole[1].slice().sort((x, y) => x - y)],
      [b.hole[0].slice().sort((x, y) => x - y), b.hole[1].slice().sort((x, y) => x - y)],
      `deal ${deal} deals the same hole cards to the same seats in both plays`
    );
  }
});

test('hidden information: two states differing only in opponent hole cards observe identically', () => {
  const base = newMatch('station', 'hidden-test');
  const variant = /** @type {MatchState} */ (JSON.parse(JSON.stringify(base)));
  const vhand = /** @type {NonNullable<MatchState['hand']>} */ (variant.hand);
  vhand.hole[1] = [
    vhand.hole[1][0] === 51 ? 50 : 51,
    vhand.hole[1][1] === 50 ? 49 : 50,
  ];
  const obsBase = holdem.observe(base, 0);
  const obsVariant = holdem.observe(variant, 0);
  assert.equal(JSON.stringify(obsBase), JSON.stringify(obsVariant), 'agent observation cannot reveal opponent cards');
  const obsOppBase = holdem.observe(base, 1);
  assert.notEqual(JSON.stringify(obsBase), JSON.stringify(obsOppBase), 'each seat sees its own cards');
});

test('hidden information: no unshown card leaks into an observation', () => {
  const state = newMatch('station', 'leak-test');
  let s = state;
  let checks = 0;
  while (s.hand !== null && checks < 40) {
    const seat = /** @type {number} */ (seatToAct(s));
    const liveHand = /** @type {NonNullable<MatchState['hand']>} */ (s.hand);
    const obs = holdem.observe(s, seat);
    const text = JSON.stringify(obs);
    // Cards shown in earlier hands are public knowledge (duplicate deals
    // legitimately re-use them after a showdown); everything else must not
    // appear.
    /** @type {Set<number>} */
    const shown = new Set();
    for (const record of s.history) {
      if (record.shown) {
        for (const h of record.shown) {
          shown.add(h[0]);
          shown.add(h[1]);
        }
      }
    }
    for (const card of liveHand.hole[1 - seat]) {
      if (!shown.has(card)) {
        assert.ok(!text.includes(cardName(card)), `observation leaked unseen opponent card ${cardName(card)}`);
      }
    }
    s = holdem.step(s, seat, 'call');
    checks++;
  }
});

test('determinism: the same seed and actions produce the same match', () => {
  const a = newMatch('station', 'det-test');
  const b = newMatch('station', 'det-test');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  let sa = a;
  let sb = b;
  while (sa.hand !== null) {
    sa = holdem.step(sa, /** @type {number} */ (seatToAct(sa)), 'call');
    sb = holdem.step(sb, /** @type {number} */ (seatToAct(sb)), 'call');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sa)), JSON.parse(JSON.stringify(sb)));
  assert.notDeepEqual(
    JSON.parse(JSON.stringify(newMatch('station', 'det-test-2'))),
    JSON.parse(JSON.stringify(newMatch('station', 'det-test'))),
    'different seeds deal differently'
  );
});

test('scoring: normalization is antisymmetric and 0.5 at break-even', () => {
  assert.equal(normalizedFromChips(0, 40), 0.5);
  const n = normalizedFromChips(80, 40);
  assert.ok(Math.abs(1 - n - normalizedFromChips(-80, 40)) < 1e-12);
  // +80 chips over 40 hands = 100 bb/100 hands → sigmoid(100/50).
  const bb100 = (80 / 2) * (100 / 40);
  assert.equal(n, 1 / (1 + Math.exp(-bb100 / 50)));
  assert.ok(n > 0.85 && n < 0.92);
});

test('scoring: outcome margins score the seat\'s own net, not the seat differential', () => {
  // Greptile PR #34: state.chips already holds each seat's net winnings
  // (chips start at [0, 0]; seat 0's win is seat 1's loss), so
  // chips[0] - chips[1] doubles the margin before bb100. +80/-80 over 40
  // hands is the documented 0.881 (100 bb/100 hands), not 0.982.
  const state = /** @type {import('./engine.js').MatchState} */ (
    /** @type {unknown} */ ({ chips: [80, -80], history: new Array(40).fill(null) })
  );
  const outcome = matchOutcome(state);
  const expected = 1 / (1 + Math.exp(-2)); // bb100 = (80 / 2) * (100 / 40) = 100
  assert.ok(Math.abs(outcome.normalized[0] - expected) < 1e-12, `seat 0 ${outcome.normalized[0]}`);
  assert.ok(Math.abs(outcome.normalized[1] - (1 - expected)) < 1e-12, `seat 1 ${outcome.normalized[1]}`);
  assert.deepEqual(outcome.raw, [80, -80]);

  // Truncation scores the completed hands the same way.
  const truncated = /** @type {import('./engine.js').MatchState} */ (
    /** @type {unknown} */ ({ chips: [20, -20], history: new Array(10).fill(null) })
  );
  const cut = truncateOutcome(truncated);
  assert.ok(Math.abs(cut.normalized[0] - expected) < 1e-12, `truncated seat 0 ${cut.normalized[0]}`);
});

test('showdown: winner and split pot settle chips correctly', () => {
  const state = newMatch('station', 'showdown-test');
  const s = /** @type {MatchState} */ (JSON.parse(JSON.stringify(state)));
  const hand = /** @type {NonNullable<MatchState['hand']>} */ (s.hand);
  hand.street = 3;
  hand.revealed = 5;
  hand.acted = [false, false];
  hand.streetPut = [0, 0];
  hand.put = [6, 6];
  hand.bet = 0;
  hand.raises = 0;
  hand.board = cards(['Kc', 'Qd', '9h', '5s', '2c']);
  hand.hole = [cards(['Ac', 'Ad']), cards(['Kh', 'Ks'])]; // trip kings beat aces
  applyAction(s, 0, 'call');
  applyAction(s, 1, 'call');
  assert.equal(s.history.length, 1);
  assert.equal(s.chips[1], 6, 'seat 1 wins the 12-chip pot for +6');
  assert.equal(s.chips[0], -6);
  assert.equal(s.history[0].winnerName, 'three of a kind, kings');

  // Split pot: identical made hands.
  const s2 = /** @type {MatchState} */ (JSON.parse(JSON.stringify(state)));
  const hand2 = /** @type {NonNullable<MatchState['hand']>} */ (s2.hand);
  hand2.street = 3;
  hand2.revealed = 5;
  hand2.acted = [false, false];
  hand2.streetPut = [0, 0];
  hand2.put = [6, 6];
  hand2.bet = 0;
  hand2.raises = 0;
  hand2.board = cards(['Kc', 'Qd', '9h', '5s', '2c']);
  hand2.hole = [cards(['Ac', 'Ad']), cards(['Ah', 'As'])];
  applyAction(s2, 0, 'call');
  applyAction(s2, 1, 'call');
  assert.deepEqual(s2.chips, [0, 0], 'exact tie splits the pot evenly');
  assert.ok(s2.history[0].reason.includes('split'));
});

test('conformance: runConformance passes every tier', async () => {
  const report = await runConformance(holdem, { seedsPerTier: 2 });
  assert.equal(report.ok, true);
  assert.ok(report.checks > 0);
});

test('runner: a full episode against the station tier verifies as a trajectory', async () => {
  const tier = holdem.spec.tiers[0];
  const seed = publicSeed(GAME_ID, tier.id, 0);
  const agent = makeBaseline('greedy', seed, 0);
  const trajectory = await runEpisode({ game: holdem, tierId: tier.id, seed, agent });
  assert.equal(trajectory.end.reason, 'terminal');
  const clean = await verifyTrajectory(holdem, trajectory);
  assert.deepEqual(clean, { ok: true });
  // Tampering with an action must fail verification.
  const tampered = JSON.parse(JSON.stringify(trajectory));
  const firstAgentStep = tampered.steps.find((/** @type {{ by: string }} */ st) => st.by === 'agent');
  firstAgentStep.action = firstAgentStep.action === 'fold' ? 'call' : 'fold';
  const result = await verifyTrajectory(holdem, tampered);
  assert.equal(result.ok, false, 'the verifier must reject the tampered trajectory');
});
