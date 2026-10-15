/**
 * Episode planning: from a suite manifest, the flat list of episode jobs a run
 * must play, plus the shared helpers every other `runs/` module needs to
 * interpret a manifest (game lookup, manifest hash, trajectory paths). Pure
 * string/set logic except the hash; nothing here touches the filesystem.
 *
 * @module
 */

import { canonicalJson } from '../core/canonical.js';
import { SUITE_FORMAT } from '../scoring/suite.js';

import { sha256Hex } from './fsutil.js';

/** @import { Game } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */

/**
 * One episode a run must play.
 *
 * @typedef {object} Job
 * @property {string} key Stable job key `"<game>/<tier>/<seed>"` — the same
 *   identity `scoring/score.js` uses for episodes, and the trajectory's path
 *   stem under the run directory.
 * @property {string} gameId
 * @property {string} tierId
 * @property {string} seed
 * @property {'public' | 'eval'} split
 */

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new Error(`[gauntlet/runs/plan.js] ${step}: ${message}`);
}

/**
 * @param {string} gameId
 * @param {string} tierId
 * @param {string} seed
 * @returns {string}
 */
export function jobKey(gameId, tierId, seed) {
  return `${gameId}/${tierId}/${seed}`;
}

/**
 * Path segments must be safe to join under the run directory: non-empty, no
 * current/parent segments, no leading separator.
 *
 * @param {string} step
 * @param {string} segment
 * @returns {string}
 */
function safeSegment(step, segment) {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.startsWith('/')
  ) {
    refuse('safe-segment', `manifest produced an unsafe path segment ${JSON.stringify(segment)}`);
  }
  void step;
  return segment;
}

/**
 * Expand a suite manifest into episode jobs, in manifest order (game order,
 * tier rank order, seed index order) so runs are reproducible from the
 * manifest alone.
 *
 * @param {SuiteManifest} suite
 * @returns {Job[]}
 */
export function planJobs(suite) {
  if (!suite || suite.format !== SUITE_FORMAT) {
    refuse(
      'suite-format',
      `expected a ${SUITE_FORMAT} manifest, got ${JSON.stringify(suite && /** @type {*} */ (suite).format)}`
    );
  }
  if (!Array.isArray(suite.games) || suite.games.length === 0) {
    refuse('suite-games', 'manifest lists no games');
  }
  /** @type {Job[]} */
  const jobs = [];
  for (const game of suite.games) {
    safeSegment('game-id', game.id);
    if (!Array.isArray(game.tiers) || game.tiers.length === 0) {
      refuse('suite-tiers', `game "${game.id}" lists no tiers`);
    }
    for (const tier of game.tiers) {
      safeSegment('tier-id', tier.id);
      if (!Array.isArray(tier.seeds) || tier.seeds.length === 0) {
        refuse('suite-seeds', `tier "${game.id}/${tier.id}" lists no seeds`);
      }
      for (const seed of tier.seeds) {
        safeSegment('seed', seed);
        jobs.push({
          key: jobKey(game.id, tier.id, seed),
          gameId: game.id,
          tierId: tier.id,
          seed,
          split: suite.split,
        });
      }
    }
  }
  if (jobs.length === 0) {
    refuse('suite-seeds', 'manifest produced no episode jobs');
  }
  return jobs;
}

/**
 * SHA-256 of the manifest's canonical JSON. Recorded in `run.json` and
 * checked by `verifyBundle`, so a results bundle is only re-verifiable
 * against the exact manifest it was played under.
 *
 * @param {SuiteManifest} suite
 * @returns {string}
 */
export function manifestSha256(suite) {
  return sha256Hex(canonicalJson(suite));
}

/**
 * Accept games as an array, a Map keyed by game id, or a plain record — the
 * same shapes `scoring/score.js` accepts — and require every suite game to
 * resolve to an implementation of the exact version the manifest pins.
 *
 * @param {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 * @param {SuiteManifest} suite
 * @returns {Map<string, Game<*>>}
 */
export function normalizeGames(games, suite) {
  /** @type {Map<string, Game<*>>} */
  let map;
  if (Array.isArray(games)) {
    map = new Map(games.map((g) => [g?.spec?.id, /** @type {Game<*>} */ (g)]));
  } else if (games instanceof Map) {
    map = /** @type {Map<string, Game<*>>} */ (games);
  } else if (games && typeof games === 'object') {
    map = new Map(Object.entries(/** @type {Record<string, Game<*>>} */ (games)));
  } else {
    refuse('games-lookup', 'games must be an array, a Map keyed by game id, or a record');
  }
  for (const suiteGame of suite.games) {
    const game = map.get(suiteGame.id);
    if (!game || !game.spec) {
      refuse(
        'games-lookup',
        `suite game "${suiteGame.id}" has no implementation in the games argument; a run needs the game to play and verify episodes`
      );
    }
    if (game.spec.version !== suiteGame.version) {
      refuse(
        'games-lookup',
        `suite lists "${suiteGame.id}" version ${suiteGame.version} but the provided implementation is version ${game.spec.version}`
      );
    }
  }
  return map;
}
