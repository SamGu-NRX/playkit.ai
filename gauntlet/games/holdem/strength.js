/**
 * Preflop hand strength for the hold'em bots: the Chen formula, a standard
 * ranked measure of two-card starting-hand strength. Scores range from -1
 * (32 offsuit) to 20 (aces). Roughly: 9+ is a premium hand (top ~15%), 5-8
 * playable, below that trash. Plain JS, no `node:*` imports.
 *
 * @module
 */

import { cardRank, cardSuit } from './cards.js';

/**
 * Chen score of a two-card preflop hand.
 *
 * @param {readonly number[]} hole Exactly two distinct cards.
 * @returns {number} Rounded-down Chen score.
 */
export function chenScore(hole) {
  const r1 = cardRank(hole[0]);
  const r2 = cardRank(hole[1]);
  const suited = cardSuit(hole[0]) === cardSuit(hole[1]);
  const high = Math.max(r1, r2);
  const low = Math.min(r1, r2);

  // High-card points: ace 10, king 8, queen 7, jack 6, ten 5, else face
  // value / 2 (nine 4.5, deuce 1). Ranks 8..12 are T, J, Q, K, A.
  const HIGH_POINTS = [5, 6, 7, 8, 10];
  const points = high >= 8 ? HIGH_POINTS[high - 8] : (high + 2) / 2;

  if (r1 === r2) {
    // Pairs: double the high-card points, minimum 5 (22 = 5).
    return Math.max(Math.floor(points * 2), 5);
  }

  let score = points;
  if (suited) score += 2;

  const gap = high - low - 1;
  if (gap === 0) score += 0.5; // connectors bonus
  else if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else score -= 5;

  // Bonus for playing 75 or 65 suited connectors (gapless, both ≤ 7).
  if (suited && gap === 0 && low <= 5 && high <= 7) score += 1;

  return Math.floor(score);
}
