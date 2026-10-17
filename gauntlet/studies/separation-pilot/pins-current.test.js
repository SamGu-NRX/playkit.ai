/**
 * Version-currency pins for the separation pilot's committed artifacts: the
 * committed suite options and the estimates priced from them must describe
 * the game registry as it is NOW. #108 bumped mastermind 1.0.0 → 1.1.0 and
 * wordle 1.1.0 → 1.2.0; the committed suites still pin the old versions, so
 * the instrument-check suites built from them refuse the registry (plan.js
 * "pins wordle 1.1.0") and every recorded estimate prices a suite that no
 * longer exists.
 *
 * Pins (the chain registry → suite → estimate):
 *   1. every committed suite's per-game version equals the registry version;
 *   2. every committed instrument suite likewise;
 *   3. every committed estimate's suite.manifestSha256 equals the manifest
 *      hash recomputed from the committed suite file with the same option
 *      name, and its suite.id matches that suite.
 *
 * When this test fails, regenerate IN ORDER: re-run the tier audit
 * (studies/tier-audit/reproduce.sh) if game versions moved, then
 *   bash studies/separation-pilot/make-suite.mjs        # re-cut the options
 *   bash studies/separation-pilot/instrument.sh         # re-check instruments
 *   bash studies/separation-pilot/estimate.sh           # re-price estimates
 * and commit the regenerated outputs.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GAMES } from '../../games/index.js';
import { manifestSha256 } from '../../runs/plan.js';

const dir = new URL('.', import.meta.url).pathname;
const suitesDir = join(dir, 'outputs/suites');
const instrumentDir = join(suitesDir, 'instrument');
const estimatesDir = join(dir, 'outputs/estimates');

/** @param {string} gameId */
function currentVersion(gameId) {
  const game = /** @type {*} */ (GAMES[gameId]);
  assert.ok(game, `game ${gameId} is not in the registry`);
  return /** @type {*} */ (game).spec.version;
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Every game entry in a committed suite must pin the registry's current
 * version. Returns the violations as human-readable strings.
 *
 * @param {string} label
 * @param {*} suite
 * @returns {string[]}
 */
function suiteVersionDrift(label, suite) {
  /** @type {string[]} */
  const drift = [];
  for (const game of /** @type {*[]} */ (suite.games)) {
    const want = currentVersion(game.id);
    if (game.version !== want) {
      drift.push(`${label}: game ${game.id} pinned ${game.version}, registry is at ${want}`);
    }
  }
  return drift;
}

test('every committed suite option pins current game versions', async () => {
  const files = (await readdir(suitesDir)).filter((f) => /^suite\..+\.json$/.test(f));
  assert.ok(files.length > 0, 'no committed suite options found');
  /** @type {string[]} */
  const drift = [];
  for (const file of files) {
    const suite = await readJson(join(suitesDir, file));
    drift.push(...suiteVersionDrift(file, suite));
  }
  assert.deepEqual(drift, [], `stale suite pins (re-run make-suite.mjs):\n${drift.join('\n')}`);
});

test('every committed instrument suite pins current game versions', async () => {
  const files = (await readdir(instrumentDir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no committed instrument suites found');
  /** @type {string[]} */
  const drift = [];
  for (const file of files) {
    const suite = await readJson(join(instrumentDir, file));
    drift.push(...suiteVersionDrift(`instrument/${file}`, suite));
  }
  assert.deepEqual(drift, [], `stale instrument suite pins (re-run instrument.sh):\n${drift.join('\n')}`);
});

test('every committed estimate prices the committed suite it is named after', async () => {
  const files = (await readdir(estimatesDir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no committed estimates found');
  /** @type {string[]} */
  const drift = [];
  for (const file of files) {
    // <option>.<provider>/<model with / -> _>.json prices suite.<option>.json
    const option = file.slice(0, file.indexOf('.'));
    const suitePath = join(suitesDir, `suite.${option}.json`);
    const suite = await readJson(suitePath);
    const estimate = await readJson(join(estimatesDir, file));
    const priced = /** @type {*} */ (estimate).suite ?? {};
    if (priced.id !== suite.id) {
      drift.push(`${file}: estimate priced suite id ${priced.id}, committed suite is ${suite.id}`);
    }
    const want = manifestSha256(suite);
    if (priced.manifestSha256 !== want) {
      drift.push(`${file}: estimate priced manifest ${priced.manifestSha256}, committed suite.${option}.json hashes to ${want}`);
    }
  }
  assert.deepEqual(drift, [], `stale estimates (re-run estimate.sh):\n${drift.join('\n')}`);
});
