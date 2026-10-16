/**
 * Reference-implementation differential tests for the hold'em evaluator.
 *
 * The evaluator packs category and kickers into a single integer
 * (evaluator.js). PR #21 review (HIGH, issue comment 6199692633) showed the
 * high-card branch dropped two kickers and that no test distinguished broken
 * from fixed; a14efa3 fixed the high-card branch. Nothing else compares the
 * packed values against an independent best-five-of-seven reference, so this
 * file adds one:
 *
 *  1. 200,000 seeded random seven-card pairs (190,000 fully random deals +
 *     10,000 dealt on a four-of-a-kind board, which concentrates samples in
 *     the quads branch): winner-or-tie must match a brute-force reference
 *     that scores all 21 five-card combinations;
 *  2. all 1,277 no-pair, no-straight five-rank sets: category 0 and every
 *     packed value distinct (1,716 7-rank sets collapse to 56 values without
 *     the a14efa3 fix — this pins the high-card packing exactly);
 *  3. crafted regressions: the review's AKQ-board pair, and a quads-board
 *     pair whose best fives are identical and must therefore tie.
 *
 * The reference is written for clarity, not speed: count ranks, detect
 * flush/straight, pick the category, pack category + up to five ranks
 * base 13 (injective because card ranks are 0..12), and take the best of
 * the 21 combinations. Winner-or-tie is compared, never the packed value
 * itself — packed values are an implementation detail, relative order is
 * the contract.
 *
 * Every random sample is drawn from `core/rng.js` with a fixed seed, so the
 * runs are deterministic.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareValues } from '../../games/holdem/evaluator.js';
import { parseCard, cardsText } from '../../games/holdem/cards.js';
import { streamFromSeed } from '../../core/rng.js';

/** 21 five-card index combinations out of seven cards, ascending. */
const COMBOS_5_OF_7 = (() => {
  /** @type {number[][]} */
  const combos = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) combos.push([a, b, c, d, e]);
  return combos;
})();

/**
 * Score one five-card hand: category then up to five tie-break ranks packed
 * base 13, most significant first. Higher is strictly better.
 *
 * @param {number[]} cards Five distinct card integers (rank = card >> 2).
 * @returns {number}
 */
function refScore5(cards) {
  const counts = new Array(13).fill(0);
  let rankMask = 0;
  let suitMask = 0;
  for (const card of cards) {
    const rank = card >> 2;
    counts[rank] += 1;
    rankMask |= 1 << rank;
    suitMask |= 1 << (card & 3);
  }
  const flush = (suitMask & (suitMask - 1)) === 0;
  let straightHigh = -1;
  for (let high = 12; high >= 4; high--) {
    const window = 31 << (high - 4);
    if ((rankMask & window) === window) {
      straightHigh = high;
      break;
    }
  }
  if (straightHigh < 0 && (rankMask & 0x100f) === 0x100f) straightHigh = 3; // wheel

  let quad = -1;
  const trips = [];
  const pairs = [];
  const singles = [];
  /** @type {number[]} */
  const descending = [];
  for (let rank = 12; rank >= 0; rank--) {
    for (let k = 0; k < counts[rank]; k++) descending.push(rank);
    const n = counts[rank];
    if (n === 4) quad = rank;
    else if (n === 3) trips.push(rank);
    else if (n === 2) pairs.push(rank);
    else if (n === 1) singles.push(rank);
  }

  const pack = (/** @type {number} */ category, /** @type {number[]} */ groupRanks) => {
    let value = category;
    for (let i = 0; i < 5; i++) {
      value = value * 13 + (i < groupRanks.length ? groupRanks[i] : 0);
    }
    return value;
  };

  if (flush && straightHigh >= 0) return pack(8, [straightHigh]);
  if (quad >= 0) {
    // The quads kicker is simply the highest remaining card: from five cards
    // there is exactly one card beside the quad, and from the best-of-21
    // reference view any full-house-with-quad alternative is worse.
    let kicker = -1;
    for (let rank = 12; rank >= 0; rank--) {
      if (rank !== quad && counts[rank] > 0) {
        kicker = rank;
        break;
      }
    }
    return pack(7, [quad, kicker]);
  }
  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    return pack(6, [trips[0], trips.length > 1 ? trips[1] : pairs[0]]);
  }
  if (flush) return pack(5, descending);
  if (straightHigh >= 0) return pack(4, [straightHigh]);
  if (trips.length === 1) return pack(3, [trips[0], singles[0], singles[1]]);
  if (pairs.length === 2) return pack(2, [pairs[0], pairs[1], singles[0]]);
  if (pairs.length === 1) return pack(1, [pairs[0], singles[0], singles[1], singles[2]]);
  return pack(0, descending);
}

/**
 * Best five-card score of a seven-card hand: max over all 21 combinations.
 *
 * @param {number[]} cards Seven distinct card integers.
 * @returns {number}
 */
function refScore7(cards) {
  let best = -1;
  for (const [a, b, c, d, e] of COMBOS_5_OF_7) {
    const score = refScore5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Winner sign between two hands in a common convention.
 *
 * @param {number} scoreA
 * @param {number} scoreB
 * @returns {number} -1, 0 or 1.
 */
function sign(scoreA, scoreB) {
  return Math.sign(scoreA - scoreB);
}

test('200,000 seeded random seven-card pairs: evaluator and best-of-21 reference agree on winner or tie', () => {
  const rng = streamFromSeed('burst10-holdem-evaluator-reference');
  const pool = Array.from({ length: 52 }, (_, i) => i);
  /** @type {Array<[number[], number[], number, number]>} */
  const disagreements = [];

  /** Partial Fisher-Yates: draw n distinct cards off the top of the pool. */
  const draw = (/** @type {number} */ n) => {
    const out = [];
    for (let t = 0; t < n; t++) {
      const j = rng.nextInt(0, 51 - t);
      const tmp = pool[j];
      pool[j] = pool[51 - t];
      pool[51 - t] = tmp;
      out.push(pool[51 - t]);
    }
    return out;
  };

  for (let trial = 0; trial < 200000; trial++) {
    /** @type {number[]} */
    let holeA;
    /** @type {number[]} */
    let holeB;
    /** @type {number[]} */
    let board;
    if (trial < 190000) {
      const dealt = draw(14);
      holeA = dealt.slice(0, 2);
      holeB = dealt.slice(2, 4);
      board = dealt.slice(4, 9);
    } else {
      // Deal a board with four of a kind so both hands are quads-heavy:
      // this concentrates samples in the quads branch, where packed-kicker
      // mistakes are invisible to category-frequency checks.
      const quadRank = rng.nextInt(0, 12);
      board = [0, 1, 2, 3].map((s) => (quadRank << 2) | s);
      const kickerRank = (quadRank + 1 + rng.nextInt(0, 11)) % 13;
      board.push((kickerRank << 2) | rng.nextInt(0, 3));
      let pairRank = rng.nextInt(0, 12);
      if (pairRank === quadRank) pairRank = (pairRank + 1) % 13;
      const suitA1 = rng.nextInt(0, 3);
      const suitA2 = (suitA1 + 1 + rng.nextInt(0, 2)) % 4;
      holeA = [(pairRank << 2) | suitA1, (pairRank << 2) | suitA2];
      // Hole B: two distinct cards from the 45 still unaccounted for.
      const used = new Set([...board, ...holeA]);
      const rest = [];
      for (let card = 0; card < 52; card++) {
        if (!used.has(card)) rest.push(card);
      }
      const j1 = rng.nextInt(0, rest.length - 1);
      const card1 = rest[j1];
      rest[j1] = rest[rest.length - 1];
      rest.pop();
      const j2 = rng.nextInt(0, rest.length - 1);
      const card2 = rest[j2];
      holeB = [card1, card2];
    }
    const sevenA = [...holeA, ...board];
    const sevenB = [...holeB, ...board];
    const engineSign = sign(evaluate(sevenA).value, evaluate(sevenB).value);
    const refSign = sign(refScore7(sevenA), refScore7(sevenB));
    if (engineSign !== refSign) {
      disagreements.push([sevenA, sevenB, engineSign, refSign]);
      if (disagreements.length > 10) break; // report a bounded sample
    }
  }
  assert.deepEqual(
    disagreements.map(([a, b, e, r]) => `${cardsText(a)} vs ${cardsText(b)}: engine ${e}, reference ${r}`),
    [],
    'evaluator disagrees with the best-of-21 reference'
  );
});

test('all 1,277 no-pair, no-straight five-rank sets evaluate to category 0 with distinct values', () => {
  /** @type {Set<number>} */
  const seen = new Set();
  let count = 0;
  for (let mask = 0; mask < 8192; mask++) {
    let bits = 0;
    for (let m = mask; m !== 0; m &= m - 1) bits++;
    if (bits !== 5) continue;
    let straight = false;
    for (let high = 4; high <= 12; high++) {
      const window = 31 << (high - 4);
      if ((mask & window) === window) straight = true;
    }
    if ((mask & 0x100f) === 0x100f) straight = true;
    if (straight) continue;
    const cards = [];
    let suitIndex = 0;
    for (let rank = 0; rank < 13; rank++) {
      if (mask & (1 << rank)) cards.push((rank << 2) | [0, 1, 2, 0, 1][suitIndex++]);
    }
    const result = evaluate(cards);
    assert.equal(result.category, 0, `${cardsText(cards)} must be no-pair`);
    assert.ok(!seen.has(result.value), `duplicate high-card value for ${cardsText(cards)}`);
    seen.add(result.value);
    count++;
  }
  // C(13,5) = 1287 five-rank sets, minus the 10 straights (nine windows + wheel).
  assert.equal(count, 1277);
  assert.equal(seen.size, 1277);
});

test('crafted regression pairs: review pair wins, quads-board equal best fives tie', () => {
  // PR #21 review pair: on the Ac Kd Qh 4s 2c board, 9-8 must beat 7-6.
  const boardAKQ = ['Ac', 'Kd', 'Qh', '4s', '2c'].map((t) => /** @type {number} */ (parseCard(t)));
  const highPair = ['9d', '8c'].map((t) => /** @type {number} */ (parseCard(t)));
  const lowPair = ['7d', '6c'].map((t) => /** @type {number} */ (parseCard(t)));
  assert.ok(
    compareValues(evaluate([...highPair, ...boardAKQ]).value, evaluate([...lowPair, ...boardAKQ]).value) > 0,
    '9-8 must beat 7-6 on the Ac Kd Qh 4s 2c board (compareValues is a - b, positive = first wins)'
  );

  // Quads board 2222K: hole 55 and hole 43 both make the same best five
  // (2222K) — the pair cannot be played as a kicker — so the pot must split.
  const boardQuads = ['2c', '2d', '2h', '2s', 'Kc'].map((t) => /** @type {number} */ (parseCard(t)));
  const overPair = ['5c', '5d'].map((t) => /** @type {number} */ (parseCard(t)));
  const lowCards = ['4d', '3c'].map((t) => /** @type {number} */ (parseCard(t)));
  const sevenOver = [...overPair, ...boardQuads];
  const sevenLow = [...lowCards, ...boardQuads];
  assert.equal(
    sign(refScore7(sevenOver), refScore7(sevenLow)),
    0,
    'reference: 2222K vs 2222K is a tie'
  );
  assert.equal(
    compareValues(evaluate(sevenOver).value, evaluate(sevenLow).value),
    0,
    'engine: 55 and 43 on a 2222K board must tie'
  );
  assert.equal(evaluate(sevenOver).category, 7);
  assert.equal(evaluate(sevenLow).category, 7);

  // Sanity: a true ace kicker beats the king kicker on the same board.
  const aceKicker = ['Ad', 'Ah'].map((t) => /** @type {number} */ (parseCard(t)));
  const qqPair = ['Qc', 'Qd'].map((t) => /** @type {number} */ (parseCard(t)));
  assert.ok(
    compareValues(evaluate([...aceKicker, ...boardQuads]).value, evaluate([...qqPair, ...boardQuads]).value) > 0,
    '2222A must beat 2222K'
  );
});
