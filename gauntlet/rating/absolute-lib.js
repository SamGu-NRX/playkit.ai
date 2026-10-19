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

/**
 * The carried run settings for a --merge-from refit: the prior file's levels
 * and games-per-colour describe the SAVED games, so meta and the report must
 * cover exactly those rungs — the current run's CLI flags say nothing about
 * what was played before, and carrying them instead would mislabel
 * meta.levels/meta.gamesPerColour and report unplayed levels as "excluded —
 * played a total sweep".
 *
 * `levels` is taken from `prior.meta.levels` when that array matches the
 * rungs actually present in the saved level-pair keys, and otherwise derived
 * from the keys' `sf-elo-<n>` rungs (so a prior saved with different flags,
 * or one whose meta is missing or drifted, still reports every carried rung
 * and nothing else). `gamesPerColour` passes through from the prior meta
 * when it is a positive integer, and is null otherwise (the caller keeps its
 * CLI flag).
 *
 * @param {{ meta?: { levels?: unknown, gamesPerColour?: unknown }, levels: Record<string, unknown> }} prior
 *   A parsed prior results file: `levels` maps `<rung>-vs-<opponent>` pair
 *   keys to the saved games.
 * @returns {{ levels: number[], gamesPerColour: number | null }} `levels`
 *   ascending; `gamesPerColour` null when the prior file does not record a
 *   usable one.
 */
export function carriedSettings(prior) {
  const RUNG_PREFIX = 'sf-elo-';
  /** @type {Set<number>} */
  const rungs = new Set();
  for (const key of Object.keys(prior.levels ?? {})) {
    const vs = key.indexOf('-vs-');
    const rung = vs === -1 ? key : key.slice(0, vs);
    if (!rung.startsWith(RUNG_PREFIX)) continue;
    const elo = Number(rung.slice(RUNG_PREFIX.length));
    if (Number.isInteger(elo)) rungs.add(elo);
  }
  const fromKeys = [...rungs].sort((x, y) => x - y);

  const priorLevels = prior.meta?.levels;
  const matchesKeys =
    Array.isArray(priorLevels) &&
    priorLevels.length === fromKeys.length &&
    priorLevels.every((n) => typeof n === 'number' && rungs.has(n));
  const levels = matchesKeys
    ? /** @type {number[]} */ (priorLevels).slice().sort((x, y) => x - y)
    : fromKeys;

  const priorGamesPerColour = prior.meta?.gamesPerColour;
  const gamesPerColour =
    typeof priorGamesPerColour === 'number' &&
    Number.isInteger(priorGamesPerColour) &&
    priorGamesPerColour > 0
      ? priorGamesPerColour
      : null;

  return { levels, gamesPerColour };
}
