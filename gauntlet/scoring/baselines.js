/**
 * Loader for committed scoring-baseline files
 * (`playkit-gauntlet-scoring-baseline/1`, e.g.
 * `baselines/random-public.json`): reads the file, hashes its exact bytes
 * (SHA-256, hex) and validates its shape. The hash travels into the score
 * output and the leaderboard JSON so every published number names the
 * baseline it was adjusted against.
 *
 * Node-only (`node:crypto`, `node:fs`), like `suite.js`'s eval seeds.
 * `score()` itself stays browser-safe: it receives the parsed baseline as
 * an option, never a path.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { validateBaseline } from './profiles.js';

/** @import { ScoringBaseline } from './profiles.js' */

/**
 * A loaded baseline file.
 *
 * @typedef {object} LoadedBaseline
 * @property {ScoringBaseline} baseline The parsed, validated baseline.
 * @property {string} sha256 SHA-256 hex of the file's exact bytes.
 */

/**
 * Load and validate a scoring-baseline file.
 *
 * @param {string} path Path to the baseline JSON file.
 * @returns {LoadedBaseline}
 */
export function loadBaselineFile(path) {
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `[gauntlet/scoring/baselines.js] baseline-json: ${path} is not valid JSON (${/** @type {Error} */ (error).message})`
    );
  }
  return { baseline: validateBaseline(parsed), sha256 };
}
