/**
 * Seven-card hand evaluator for the hold'em game. Hand strength is a single
 * packed integer so comparing strengths is an integer compare: category in
 * the top digits, tie-break ranks below it (each base 13).
 *
 * Categories: 0 high card, 1 pair, 2 two pair, 3 trips, 4 straight, 5 flush,
 * 6 full house, 7 quads, 8 straight flush.
 *
 * The core `categorize(rankMask, suitMasks, counts)` works on incremental
 * bit/count structures so the exhaustive enumeration test (all 2,598,960
 * five-card and all 133,784,560 seven-card hands) can run it without
 * rebuilding structures per hand. Plain JS, no `node:*` imports.
 *
 * @module
 */

import { cardRank, cardSuit } from './cards.js';

/** 13^5: divide a packed value by this to get the category. */
export const CATEGORY_DIVISOR = 13 * 13 * 13 * 13 * 13;

export const CATEGORY_NAMES = [
  'high card',
  'one pair',
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
];

/**
 * STRAIGHT[mask]: the high rank of the best straight in a 13-bit rank mask
 * (bit r set = rank r present), or -1. Rank 0 is a deuce, 12 an ace; the
 * wheel (A-5-4-3-2) has high rank 3 (the five). 8192-entry lookup table.
 *
 * @type {Int8Array}
 */
export const STRAIGHT = (() => {
  const table = new Int8Array(8192).fill(-1);
  // Any superset of a five-rank window contains that straight, so test the
  // windows per mask instead of only exact matches. Highest straight wins.
  for (let m = 0; m < 8192; m++) {
    for (let high = 12; high >= 4; high--) {
      const window =
        (1 << high) | (1 << (high - 1)) | (1 << (high - 2)) | (1 << (high - 3)) | (1 << (high - 4));
      if ((m & window) === window) {
        table[m] = high;
        break;
      }
    }
    // The wheel: A(12) 5 4 3 2.
    const wheel = (1 << 12) | (1 << 3) | (1 << 2) | (1 << 1) | 1;
    if (table[m] < 0 && (m & wheel) === wheel) table[m] = 3;
  }
  return table;
})();

/**
 * POPCOUNT[mask]: number of set bits in a 13-bit mask. 8192-entry table.
 *
 * @type {Int8Array}
 */
export const POPCOUNT = (() => {
  const table = new Int8Array(8192);
  for (let m = 1; m < 8192; m++) table[m] = /** @type {Int8Array} */ (table)[m >> 1] + (m & 1);
  return table;
})();

/**
 * TOP5[mask]: the top five rank bits of a 13-bit mask, packed base-13
 * descending (missing slots are 0). Precomputed for flush kickers.
 *
 * @type {Int32Array}
 */
export const TOP5 = (() => {
  const table = new Int32Array(8192);
  for (let m = 1; m < 8192; m++) {
    let v = 0;
    let slots = 5;
    for (let r = 12; r >= 0 && slots > 0; r--) {
      if (m & (1 << r)) {
        v = v * 13 + r;
        slots--;
      }
    }
    while (slots > 0) {
      v = v * 13;
      slots--;
    }
    table[m] = v;
  }
  return table;
})();

/**
 * Pack a category with descending tie-break ranks into the comparison value.
 * Pads to five rank slots with zeros.
 *
 * @param {number} category
 * @param {number[]} ranks Descending meaningful ranks.
 * @returns {number}
 */
export function packValue(category, ranks) {
  let v = category;
  for (let i = 0; i < 5; i++) v = v * 13 + (i < ranks.length ? ranks[i] : 0);
  return v;
}

/**
 * The core evaluator over incremental structures: `rankMask` is the 13-bit
 * OR of rank bits, `suitMasks[s]` the 13-bit mask of ranks in suit s, and
 * `counts[r]` the multiplicity of rank r (0..4). Returns the packed value.
 *
 * @param {number} rankMask
 * @param {Int32Array | number[]} suitMasks Length 4.
 * @param {Int8Array | number[]} counts Length 13.
 * @returns {number}
 */
export function categorize(rankMask, suitMasks, counts) {
  // Flushes first: straight flush outranks quads, flush outranks straight.
  for (let s = 0; s < 4; s++) {
    const sm = suitMasks[s];
    if (POPCOUNT[sm & 8191] >= 5) {
      const straightHigh = STRAIGHT[sm & 8191];
      if (straightHigh >= 0) return packValue(8, [straightHigh]);
      return TOP5[sm & 8191] + 5 * CATEGORY_DIVISOR;
    }
  }

  /** @type {number[]} */ const trips = [];
  /** @type {number[]} */ const pairs = [];
  let quad = -1;
  let kicker1 = -1;
  let kicker2 = -1; // best singletons
  for (let r = 12; r >= 0; r--) {
    const c = counts[r];
    if (c === 0) continue;
    if (c === 4) {
      if (quad < 0) quad = r;
    } else if (c === 3) {
      trips.push(r);
    } else if (c === 2) {
      pairs.push(r);
    } else {
      if (kicker1 < 0) kicker1 = r;
      else if (kicker2 < 0) kicker2 = r;
    }
  }

  if (quad >= 0) {
    // The quads kicker is simply the highest non-quad card: the best
    // five-card hand from quads plus three side cards always plays the quad
    // with its single highest remaining card, whatever that card is part of.
    // Ranking groups first (a pair of deuces over a lone ace) reverses real
    // winners and manufactures false ones; differential tests in
    // test/reference/holdem-evaluator.test.js pin this against a best-of-21
    // reference.
    let best = -1;
    for (let rank = 12; rank >= 0; rank--) {
      if (rank !== quad && counts[rank] > 0) {
        best = rank;
        break;
      }
    }
    return packValue(7, [quad, best]);
  }
  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    // Full house: best trip + best "pair" (another trip or a pair).
    const pairPart = Math.max(trips.length > 1 ? trips[1] : -1, pairs.length > 0 ? pairs[0] : -1);
    return packValue(6, [trips[0], pairPart]);
  }
  const straightHigh = STRAIGHT[rankMask & 8191];
  if (straightHigh >= 0) return packValue(4, [straightHigh]);
  if (trips.length > 0) {
    return packValue(3, [trips[0], kicker1, kicker2]);
  }
  if (pairs.length > 1) {
    // Two pair: the fifth card can be a third pair's rank or a singleton.
    const kicker = Math.max(pairs.length > 2 ? pairs[2] : -1, kicker1);
    return packValue(2, [pairs[0], pairs[1], kicker]);
  }
  if (pairs.length === 1) {
    // One pair from 7 cards has three kickers.
    return packValue(1, [pairs[0], kicker1, kicker2, kicker3(counts, pairs[0], kicker1, kicker2)]);
  }
  // No-pair: every rank is a singleton, so the top five ranks of the mask
  // are exactly the best-five kickers. Packing all five matters — the third
  // and below decide most showdowns where both players miss the board.
  return TOP5[rankMask & 8191];
}

/**
 * Third kicker below kicker2 for high-card / one-pair cases.
 *
 * @param {Int8Array | number[]} counts
 * @param {number} exclude1 Rank to skip (the pair rank, or -1).
 * @param {number} k1 Best kicker (already found).
 * @param {number} k2 Second kicker (already found, may be -1).
 * @returns {number}
 */
function kicker3(counts, exclude1, k1, k2) {
  for (let r = 12; r >= 0; r--) {
    if (counts[r] === 1 && r !== exclude1 && r !== k1 && r !== k2) return r;
  }
  return 0;
}

/**
 * Structures for one evaluation, reused across calls (single-threaded use).
 *
 * @type {{ rankMask: number, suitMasks: Int32Array, counts: Int8Array }}
 */
const scratch = { rankMask: 0, suitMasks: new Int32Array(4), counts: new Int8Array(13) };

/**
 * @returns {void}
 */
function clearScratch() {
  scratch.rankMask = 0;
  for (let s = 0; s < 4; s++) scratch.suitMasks[s] = 0;
  for (let r = 0; r < 13; r++) scratch.counts[r] = 0;
}

/**
 * Evaluate exactly seven distinct cards (the hold'em case: hole + board).
 * Also accepts 5 or 6 cards (partial boards) — every hand type is well
 * defined there.
 *
 * @param {readonly number[]} cards Distinct card integers.
 * @returns {{ value: number, category: number, name: string }}
 */
export function evaluate(cards) {
  clearScratch();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const r = cardRank(card);
    const s = cardSuit(card);
    const bit = 1 << r;
    scratch.rankMask |= bit;
    scratch.suitMasks[s] |= bit;
    scratch.counts[r]++;
  }
  const value = categorize(scratch.rankMask, scratch.suitMasks, scratch.counts);
  const category = Math.floor(value / CATEGORY_DIVISOR);
  return { value, category, name: describe(category, value % CATEGORY_DIVISOR) };
}

/**
 * Evaluate the best five-card hand out of seven (two hole cards plus a
 * five-card board). Alias of {@link evaluate} for 5..7 cards.
 *
 * @param {readonly number[]} cards
 * @returns {{ value: number, category: number, name: string }}
 */
export function evaluate7(cards) {
  return evaluate(cards);
}

/**
 * Human description like "flush, ace high" or "two pair, kings and nines".
 *
 * @param {number} category
 * @param {number} ranksPart The five base-13 tie-break digits.
 * @returns {string}
 */
export function describe(category, ranksPart) {
  const digits = [];
  let v = ranksPart;
  for (let i = 0; i < 5; i++) {
    digits.unshift(v % 13);
    v = Math.floor(v / 13);
  }
  const rankName = /** @param {number} r */ (r) => RANK_WORD[r];
  switch (category) {
    case 8:
      return `straight flush, ${rankName(digits[0])} high`;
    case 7:
      return `four of a kind, ${rankName(digits[0])}s`;
    case 6:
      return `full house, ${rankName(digits[0])}s over ${rankName(digits[1])}s`;
    case 5:
      return `flush, ${rankName(digits[0])} high`;
    case 4:
      return `straight, ${rankName(digits[0])} high`;
    case 3:
      return `three of a kind, ${rankName(digits[0])}s`;
    case 2:
      return `two pair, ${rankName(digits[0])}s and ${rankName(digits[1])}s`;
    case 1:
      return `one pair, ${rankName(digits[0])}s`;
    default:
      return `high card, ${rankName(digits[0])}`;
  }
}

const RANK_WORD = [
  'deuce',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'jack',
  'queen',
  'king',
  'ace',
];

/** Negative when a wins, positive when b wins, zero for an exact tie.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function compareValues(a, b) {
  return a - b;
}
