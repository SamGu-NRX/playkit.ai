/**
 * Version-currency integration test: every scoring profile needs a current
 * calibration and a current random baseline, so a game version bump without a
 * recalibration (or a regenerated baseline) must fail the suite, not the
 * leaderboard.
 *
 * For every registered game with `spec.benchmark`:
 *   1. `calibration/tables/<id>.json` exists, was calibrated at the installed
 *      game version, and covers exactly the spec's tiers; and
 *   2. `scoring/baselines/random-public.json` has an entry for the game at the
 *      same version and the same tier set.
 *
 * Failures are collected and reported as one list so the fix is obvious
 * (regenerate the table with `node calibration/run.js --games=<id>`, then the
 * baseline with `node scoring/generate-baseline.js`).
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GAMES } from '../../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = dirname(dirname(here));

const tablePath = (/** @type {string} */ id) => join(gauntletRoot, 'calibration', 'tables', `${id}.json`);
const baselinePath = join(gauntletRoot, 'scoring', 'baselines', 'random-public.json');

/**
 * Tier ids of a calibration table, from the random block (the block every
 * committed table carries).
 *
 * @param {{ baselines?: Record<string, { tiers?: Record<string, unknown> }> }} table
 * @returns {string[]}
 */
function tableTierIds(table) {
  return Object.keys(table.baselines?.random?.tiers ?? {});
}

test('every benchmark game has a current calibration table and random baseline', () => {
  /** @type {string[]} */
  const stale = [];

  /** @type {Record<string, { version: string, tiers: Record<string, unknown> }>} */
  const baselineGames = JSON.parse(readFileSync(baselinePath, 'utf8')).games;

  for (const game of Object.values(GAMES)) {
    const spec = game.spec;
    if (!spec?.benchmark) continue;

    // 1. The calibration table exists and is current.
    if (!existsSync(tablePath(spec.id))) {
      stale.push(`${spec.id}: no calibration table at calibration/tables/${spec.id}.json (game v${spec.version})`);
      continue;
    }
    const table = JSON.parse(readFileSync(tablePath(spec.id), 'utf8'));
    if (table.game?.version !== spec.version) {
      stale.push(
        `${spec.id}: table calibrated on v${table.game?.version} but the installed game is v${spec.version} — regenerate with node calibration/run.js --games=${spec.id}`
      );
    }
    const specTierIds = (spec.tiers ?? []).map((/** @type {{ id: string }} */ t) => t.id);
    const gotTierIds = tableTierIds(table);
    const missingTiers = specTierIds.filter((id) => !gotTierIds.includes(id));
    const extraTiers = gotTierIds.filter((id) => !specTierIds.includes(id));
    if (missingTiers.length > 0 || extraTiers.length > 0) {
      stale.push(
        `${spec.id}: table tiers [${gotTierIds.join(', ')}] != spec tiers [${specTierIds.join(', ')}]` +
          (missingTiers.length ? ` (missing: ${missingTiers.join(', ')})` : '') +
          (extraTiers.length ? ` (stale: ${extraTiers.join(', ')})` : '')
      );
    }

    // 2. The random baseline covers the game at the same version and tiers.
    const base = baselineGames[spec.id];
    if (!base) {
      stale.push(
        `${spec.id}: no random-public.json entry — regenerate with node scoring/generate-baseline.js`
      );
      continue;
    }
    if (base.version !== spec.version) {
      stale.push(
        `${spec.id}: random baseline records v${base.version} but the installed game is v${spec.version} — regenerate with node scoring/generate-baseline.js`
      );
    }
    const baseTierIds = Object.keys(base.tiers ?? {});
    if (JSON.stringify([...baseTierIds].sort()) !== JSON.stringify([...specTierIds].sort())) {
      stale.push(
        `${spec.id}: random baseline tiers [${baseTierIds.join(', ')}] != spec tiers [${specTierIds.join(', ')}] — regenerate with node scoring/generate-baseline.js`
      );
    }
  }

  assert.deepEqual(
    stale,
    [],
    `stale calibration/baseline entries (${stale.length}) — every benchmark game needs a table and a random baseline at its current version:\n  ${stale.join('\n  ')}`
  );
});
