/**
 * The study's expert per game: the game's `engine` baseline from the
 * calibration map (`calibration/games.js`), the one authoritative place the
 * packet baselines are named. All six games in this study have an engine
 * baseline there, so the dial's `greedy`-where-no-engine-exists fallback is
 * never used; it is documented in REPORT.md anyway.
 *
 * The engine baseline for chess, chess-endgames, chess-puzzles and hold'em is
 * tier- and seed-scoped (the factory needs them before the episode starts),
 * exactly as `calibration/run.js` builds it.
 *
 * @module
 */

import { CALIBRATION_GAMES, makeBaselineAgent } from '../../../calibration/games.js';

/** @import { Agent, Game, TierSpec } from '../../../core/types.js' */

/**
 * @typedef {object} ExpertEpisode
 * @property {Game<*>} game The game object.
 * @property {TierSpec} tier The episode's tier.
 * @property {string} seed The episode's seed string.
 * @property {number} seat The seat the runner will give the agent.
 */

/**
 * Build the engine-baseline expert for one episode of one game.
 *
 * @param {string} gameId The game id, one of the six study games.
 * @param {ExpertEpisode} episode The episode the expert will play.
 * @returns {Agent} The engine baseline agent (calibration id `engine`).
 * @throws {Error} when the game has no calibration entry.
 */
export function engineExpertFor(gameId, episode) {
  const entry = CALIBRATION_GAMES.find((g) => g.id === gameId);
  if (!entry) {
    throw new Error(
      `engineExpertFor: no calibration entry for game "${gameId}" (known: ${CALIBRATION_GAMES.map((g) => g.id).join(', ')})`
    );
  }
  return makeBaselineAgent(entry, 'engine', {
    episodeSeed: episode.seed,
    tier: episode.tier,
    seat: episode.seat,
  });
}
