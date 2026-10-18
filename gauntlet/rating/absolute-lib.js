/**
 * Pure helpers for `rating/absolute.js`, extracted so they are importable
 * and testable without running the CLI (`absolute.js` runs `main()` on
 * import). No `node:*` imports.
 *
 * @module
 */

/** @import { GameResult } from './elo.js'; */

/**
 * Players whose every recorded game is information-free for the anchored
 * maximum-likelihood fit: one who scored zero points across all their games
 * (all losses — the likelihood's maximum sits at rating -infinity) or
 * conceded zero points across all their games (all wins — the maximum sits
 * at +infinity). In both directions each such game's likelihood factor is 1
 * and its gradient contribution is 0 for every other player, so the games
 * are dropped before the fit instead of tripping fitRatings' divergence
 * guard.
 *
 * A player with at least one win AND one loss — even without a single draw —
 * has finite-rating evidence and is kept. (The earlier draw-only test dropped
 * decisive-game players like the committed sf-elo-1700 rung, which went
 * 1-31 in 32 games with no draws and is perfectly rateable.)
 *
 * @param {readonly GameResult[]} games Fit input, ladder and calibration
 *   games alike. `score` is from `a`'s perspective.
 * @returns {string[]} Excluded player ids, sorted.
 */
export function sweptOnlyPlayers(games) {
  /** @type {Map<string, { pointsFor: number, pointsAgainst: number }>} */
  const points = new Map();
  /**
   * @param {string} player
   * @returns {{ pointsFor: number, pointsAgainst: number }}
   */
  const entry = (player) => {
    let record = points.get(player);
    if (record === undefined) {
      record = { pointsFor: 0, pointsAgainst: 0 };
      points.set(player, record);
    }
    return record;
  };
  for (const g of games) {
    entry(g.a).pointsFor += g.score;
    entry(g.a).pointsAgainst += 1 - g.score;
    entry(g.b).pointsFor += 1 - g.score;
    entry(g.b).pointsAgainst += g.score;
  }
  return [...points.keys()]
    .filter((p) => {
      const record = /** @type {{ pointsFor: number, pointsAgainst: number }} */ (
        points.get(p)
      );
      return record.pointsFor === 0 || record.pointsAgainst === 0;
    })
    .sort();
}
