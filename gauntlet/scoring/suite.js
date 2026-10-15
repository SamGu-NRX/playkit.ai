/**
 * The suite manifest, format `playkit-gauntlet-suite/1`: the fixed list of
 * games, tiers and seeds an entry is scored against. Built from game objects
 * with `buildSuite`. Public seeds are pure string formatting; eval seeds need
 * HMAC, so this module imports `core/seeds-node.js` and is Node-only (the
 * manifest itself is plain JSON and safe to ship anywhere once built).
 *
 * @module
 */

import { publicSeed } from '../core/seeds.js';
import { evalSeed, saltCommitment as hashSalt } from '../core/seeds-node.js';

/** @import { Game } from '../core/types.js' */

export const SUITE_FORMAT = 'playkit-gauntlet-suite/1';

/**
 * One tier of a suite game, with its concrete seed list.
 *
 * @typedef {object} SuiteTier
 * @property {string} id
 * @property {number} rank
 * @property {'outcome' | 'efficiency'} scoring
 * @property {'optimal' | 'reference'} [parKind] Present exactly on efficiency
 *   tiers.
 * @property {string[]} seeds Every seed an entry must cover, in index order.
 */

/**
 * One game in the suite manifest.
 *
 * @typedef {object} SuiteGame
 * @property {string} id
 * @property {string} version
 * @property {string[]} requires External programs the game shells out to.
 * @property {SuiteTier[]} tiers
 */

/**
 * @typedef {object} SuiteManifest
 * @property {'playkit-gauntlet-suite/1'} format
 * @property {string} id
 * @property {'public' | 'eval'} split
 * @property {string | null} saltCommitment SHA-256 hex of the eval salt, or
 *   null on the public split.
 * @property {SuiteGame[]} games
 */

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new Error(`[gauntlet/scoring/suite.js] ${step}: ${message}`);
}

/**
 * Build a suite manifest from game objects.
 *
 * On the public split, tier seed i is `publicSeed(gameId, tierId, i)` for
 * `i < spec.tiers[j].publicSeeds`. On the eval split, seed i is
 * `evalSeed(gameId, tierId, i, salt)` and the manifest records only the
 * salt commitment — the salt itself is never stored.
 *
 * @param {Game<*>[]} games The game objects making up the suite.
 * @param {object} options
 * @param {'public' | 'eval'} options.split Which seed split the suite scores.
 * @param {string} [options.salt] Required when split is "eval"; rejected on
 *   the public split.
 * @param {string} [options.id] Suite id; defaults to
 *   `playkit-gauntlet-<split>`.
 * @returns {SuiteManifest}
 */
export function buildSuite(games, options) {
  if (!Array.isArray(games) || games.length === 0) {
    refuse('buildSuite', 'games must be a non-empty array of game objects');
  }
  const { split, salt, id } = options ?? /** @type {typeof options} */ ({});
  if (split !== 'public' && split !== 'eval') {
    refuse('buildSuite', `split must be "public" or "eval", got ${JSON.stringify(split)}`);
  }
  if (split === 'eval' && (typeof salt !== 'string' || salt.length === 0)) {
    refuse('buildSuite', 'an eval-split suite requires a non-empty salt string');
  }
  if (split === 'public' && salt !== undefined) {
    refuse('buildSuite', 'a public-split suite must not carry a salt');
  }

  /** @type {SuiteGame[]} */
  const manifestGames = [];
  /** @type {Set<string>} */
  const seenIds = new Set();

  for (const game of games) {
    const spec = game?.spec;
    if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
      refuse('buildSuite', 'every game must carry a spec.id string');
    }
    if (seenIds.has(spec.id)) {
      refuse('buildSuite', `duplicate game id "${spec.id}"`);
    }
    seenIds.add(spec.id);
    if (typeof spec.version !== 'string' || spec.version.length === 0) {
      refuse('buildSuite', `game "${spec.id}" must carry a non-empty spec.version`);
    }
    if (!Array.isArray(spec.tiers) || spec.tiers.length === 0) {
      refuse('buildSuite', `game "${spec.id}" must declare at least one tier`);
    }

    const sortedTiers = [...spec.tiers].sort((a, b) => a.rank - b.rank);
    sortedTiers.forEach((tier, index) => {
      if (tier.rank !== index + 1) {
        refuse(
          'tier-ranks',
          `game "${spec.id}" tier "${tier.id}" has rank ${tier.rank}; ranks must be unique and consecutive from 1 (position ${index + 1})`
        );
      }
      if (!Number.isInteger(tier.publicSeeds) || tier.publicSeeds < 1) {
        refuse(
          'tier-seeds',
          `game "${spec.id}" tier "${tier.id}" has publicSeeds ${JSON.stringify(tier.publicSeeds)}; it must be an integer >= 1`
        );
      }
      if (tier.scoring !== 'outcome' && tier.scoring !== 'efficiency') {
        refuse(
          'tier-scoring',
          `game "${spec.id}" tier "${tier.id}" has scoring ${JSON.stringify(tier.scoring)}; expected "outcome" or "efficiency"`
        );
      }
      if (tier.scoring === 'efficiency' && tier.parKind !== 'optimal' && tier.parKind !== 'reference') {
        refuse(
          'tier-scoring',
          `efficiency tier "${tier.id}" of game "${spec.id}" requires parKind "optimal" or "reference"`
        );
      }
    });

    /** @type {SuiteTier[]} */
    const manifestTiers = sortedTiers.map((tier) => {
      const seeds = [];
      for (let i = 0; i < tier.publicSeeds; i++) {
        seeds.push(
          split === 'public'
            ? publicSeed(spec.id, tier.id, i)
            : evalSeed(spec.id, tier.id, i, /** @type {string} */ (salt))
        );
      }
      /** @type {SuiteTier} */
      const out = {
        id: tier.id,
        rank: tier.rank,
        scoring: tier.scoring,
        seeds,
      };
      if (tier.scoring === 'efficiency') {
        out.parKind = /** @type {'optimal' | 'reference'} */ (tier.parKind);
      }
      return out;
    });

    manifestGames.push({
      id: spec.id,
      version: spec.version,
      requires: [...(spec.requires ?? [])],
      tiers: manifestTiers,
    });
  }

  /** @type {SuiteManifest} */
  return {
    format: SUITE_FORMAT,
    id: typeof id === 'string' && id.length > 0 ? id : `playkit-gauntlet-${split}`,
    split,
    saltCommitment: split === 'eval' ? hashSalt(/** @type {string} */ (salt)) : null,
    games: manifestGames,
  };
}

/**
 * Look up one tier of one suite game.
 *
 * @param {SuiteManifest} suite
 * @param {string} gameId
 * @param {string} tierId
 * @returns {SuiteTier | null}
 */
export function findSuiteTier(suite, gameId, tierId) {
  const game = suite.games.find((g) => g.id === gameId);
  if (!game) return null;
  return game.tiers.find((t) => t.id === tierId) ?? null;
}
