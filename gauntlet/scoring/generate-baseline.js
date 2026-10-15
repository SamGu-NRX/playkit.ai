#!/usr/bin/env node
/**
 * Generate `scoring/baselines/random-public.json` from the committed
 * calibration tables (`calibration/tables/*.json`): the per-tier random
 * baseline means that the `chance-adjusted` scoring profile subtracts.
 *
 * The file records, for every calibration game, its id and version, each
 * tier's random mean with its bootstrap interval and episode count, and the
 * SHA-256 of every source table so a regenerated file is auditable back to
 * the run that produced it.
 *
 * Usage from `gauntlet/`:
 *
 *   node scoring/generate-baseline.js [--tables=calibration/tables] [--out=scoring/baselines/random-public.json]
 *
 * Deterministic: same tables, byte-identical output. The calibration
 * integration packet regenerates this file when the recalibration threads'
 * retuned tables land.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { BASELINE_FORMAT } from './profiles.js';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = resolve(here, '..');

const args = /** @type {Record<string, string | boolean>} */ ({});
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (match) args[match[1]] = match[2] ?? true;
}

/** @type {string} */
const tablesDir = resolve(
  gauntletRoot,
  typeof args.tables === 'string' ? args.tables : 'calibration/tables'
);
/** @type {string} */
const outPath = resolve(
  gauntletRoot,
  typeof args.out === 'string' ? args.out : 'scoring/baselines/random-public.json'
);

/** @type {string[]} */
const tableFiles = readdirSync(tablesDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
  .sort();

if (tableFiles.length === 0) {
  console.error(`generate-baseline: no calibration tables found in ${tablesDir}`);
  process.exit(1);
}

/** @type {{ gameId: string, path: string, sha256: string }[]} */
const sourceTables = [];
/** @type {Record<string, unknown>} */
const games = {};

for (const file of tableFiles) {
  const bytes = readFileSync(join(tablesDir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const table = /** @type {any} */ (JSON.parse(bytes.toString('utf8')));
  const gameId = /** @type {string} */ (table.game?.id);
  if (!gameId || typeof table.game?.version !== 'string') {
    console.error(`generate-baseline: ${file} is not a calibration table (missing game.id/version)`);
    process.exit(1);
  }
  sourceTables.push({
    gameId,
    path: relative(gauntletRoot, join(tablesDir, file)).replaceAll('\\', '/'),
    sha256,
  });

  /** @type {Record<string, unknown>} */
  const tiers = {};
  const randomTiers = table.baselines?.random?.tiers ?? {};
  for (const tierId of Object.keys(randomTiers)) {
    const tier = randomTiers[tierId];
    tiers[tierId] = {
      scoring: tier.scoring,
      mean: tier.score.value,
      ci95: tier.score.ci95,
      episodes: tier.episodes,
    };
  }
  games[gameId] = {
    id: gameId,
    version: table.game.version,
    benchmark: table.game.benchmark === true,
    tiers,
  };
}

const baseline = {
  format: BASELINE_FORMAT,
  agent: 'random',
  split: 'public',
  note:
    'Random-baseline means for the chance-adjusted scoring profile, generated from the committed calibration tables by scoring/generate-baseline.js. Efficiency tiers are recorded but unused: random scores exactly 0 there.',
  sourceTables,
  games,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
const outSha = createHash('sha256').update(readFileSync(outPath)).digest('hex');
console.log(`wrote ${relative(gauntletRoot, outPath)} (sha256 ${outSha})`);
