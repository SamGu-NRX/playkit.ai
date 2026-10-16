/**
 * `gauntlet suite build`: construct a suite manifest through
 * scoring/suite.js. The manifest pins the split, the games, and — per tier —
 * the exact seed list an entry must cover. Public suites list the public
 * seeds; eval suites derive salted seeds from `--salt-file` and record the
 * salt commitment. Node-only.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { buildSuite } from '../scoring/suite.js';
import { GAMES } from '../games/index.js';

/** @import { Game } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */

/**
 * @param {string} path
 * @returns {string}
 */
function readSaltFile(path) {
  const raw = readFileSync(path, 'utf8');
  // One salt per file; surrounding whitespace and a trailing newline are
  // editorial, not part of the secret.
  const salt = raw.trim();
  if (salt.length === 0) {
    throw new Error(`salt file "${path}" is empty`);
  }
  return salt;
}

/**
 * Cap every tier's seed count at `n` with shallow copies — the game objects
 * themselves are immutable once registered.
 *
 * @param {Game<*>[]} games
 * @param {number} n
 * @returns {Game<*>[]}
 */
function capSeedsPerTier(games, n) {
  return games.map((game) => ({
    ...game,
    spec: {
      ...game.spec,
      tiers: game.spec.tiers.map((tier) =>
        tier.publicSeeds > n ? { ...tier, publicSeeds: n } : tier
      ),
    },
  }));
}

/**
 * @typedef {object} BuildSuiteOptions
 * @property {'public' | 'eval'} split
 * @property {string} [saltFile] Required for the eval split.
 * @property {number} [seedsPerTier] Cap the seed list per tier (default: all
 *   public seeds). Used for smoke suites and integration tests; a suite built
 *   with a cap only ranks entries against its own manifest.
 * @property {string[]} [gameIds] Registry ids to include (default: every
 *   registered game, in registry order).
 */

/**
 * @param {BuildSuiteOptions} options
 * @returns {SuiteManifest}
 */
export function buildSuiteManifest(options) {
  const { split, saltFile, seedsPerTier, gameIds } = options;
  if (split !== 'public' && split !== 'eval') {
    throw new Error(`suite split must be "public" or "eval", got ${JSON.stringify(split)}`);
  }
  if (split === 'eval' && !saltFile) {
    throw new Error('an eval-split suite requires --salt-file <file> (the file holds the secret salt)');
  }
  if (split === 'public' && saltFile) {
    throw new Error('a public-split suite takes no --salt-file; the salt belongs to the eval split');
  }
  if (seedsPerTier !== undefined && (!Number.isInteger(seedsPerTier) || seedsPerTier < 1)) {
    throw new Error(`--seeds-per-tier must be a positive integer, got ${JSON.stringify(seedsPerTier)}`);
  }

  const ids = gameIds ?? Object.keys(GAMES);
  if (ids.length === 0) {
    throw new Error('no games selected for the suite');
  }
  const unknown = ids.filter((id) => !GAMES[id]);
  if (unknown.length > 0) {
    throw new Error(`unknown game id(s) in --games: ${unknown.join(', ')} (registered: ${Object.keys(GAMES).join(', ')})`);
  }
  /** @type {Game<*>[]} */
  const games = ids.map((id) => /** @type {Game<*>} */ (GAMES[id]));
  const capped = seedsPerTier !== undefined ? capSeedsPerTier(games, seedsPerTier) : games;

  const salt = split === 'eval' ? readSaltFile(/** @type {string} */ (saltFile)) : undefined;
  const id = [
    'gauntlet',
    split,
    ...(seedsPerTier !== undefined ? [`first${seedsPerTier}`] : []),
    ...(gameIds ? [ids.join('+')] : []),
  ].join('-');

  return buildSuite(capped, {
    split,
    ...(salt !== undefined ? { salt } : {}),
    id,
  });
}

/**
 * Read and structurally validate a suite manifest file.
 *
 * @param {string} path
 * @returns {SuiteManifest}
 */
export function readSuiteFile(path) {
  const raw = /** @type {*} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (!raw || raw.format !== 'playkit-gauntlet-suite/1') {
    throw new Error(
      `"${path}" is not a gauntlet suite manifest (format ${JSON.stringify(raw && raw.format)})`
    );
  }
  if (raw.split !== 'public' && raw.split !== 'eval') {
    throw new Error(`suite "${path}" has an unknown split ${JSON.stringify(raw.split)}`);
  }
  if (!Array.isArray(raw.games) || raw.games.length === 0) {
    throw new Error(`suite "${path}" lists no games`);
  }
  for (const game of /** @type {Array<*>=} */ (raw.games) ?? []) {
    if (!game || typeof game.id !== 'string' || !Array.isArray(game.tiers)) {
      throw new Error(`suite "${path}" has a malformed game entry`);
    }
    for (const tier of /** @type {Array<*>=} */ (game.tiers) ?? []) {
      if (!tier || typeof tier.id !== 'string' || !Array.isArray(tier.seeds)) {
        throw new Error(`suite "${path}" has a malformed tier under game "${game && game.id}"`);
      }
    }
  }
  return /** @type {SuiteManifest} */ (raw);
}
