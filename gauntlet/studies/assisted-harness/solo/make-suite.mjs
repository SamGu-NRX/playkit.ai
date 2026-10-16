#!/usr/bin/env node
/**
 * Build a one-tier public suite manifest for the model-separation-v2 solo study.
 *
 * Usage: node make-suite.mjs <gameId> <tierId> <seedCount> [--id <suiteId>]
 *
 * Reads the tier definition straight from the registered game so scoring,
 * parKind, rank and version can never drift from what the runner will verify.
 * Public seeds are `publicSeed(game, tier, i)` for i in 0..seedCount-1.
 * Prints the manifest JSON to stdout.
 *
 * @module
 */

import { GAMES } from '../../../games/index.js';
import { publicSeed } from '../../../core/seeds.js';

const [gameId, tierId, seedCountRaw] = process.argv.slice(2).filter((a) => a !== '--id');
const idFlag = process.argv.indexOf('--id');
const suiteId = idFlag >= 0 ? process.argv[idFlag + 1] : null;
const seedCount = Number(seedCountRaw);

if (!gameId || !tierId || !Number.isInteger(seedCount) || seedCount < 1) {
  console.error('usage: node make-suite.mjs <gameId> <tierId> <seedCount> [--id <suiteId>]');
  process.exit(2);
}

const game = GAMES[gameId];
if (!game) {
  console.error(`unknown game "${gameId}"`);
  process.exit(2);
}
const spec = game.spec;
const def = spec.tiers.find((t) => t.id === tierId);
if (!def) {
  console.error(`game "${gameId}" has no tier "${tierId}" (has: ${spec.tiers.map((t) => t.id).join(', ')})`);
  process.exit(2);
}

const suite = {
  format: 'playkit-gauntlet-suite/1',
  id: suiteId ?? `gauntlet-public-msep-v2-${gameId}-${tierId}-${seedCount}`,
  split: 'public',
  saltCommitment: null,
  games: [
    {
      id: spec.id,
      version: spec.version,
      requires: spec.requires ?? [],
      tiers: [
        {
          id: def.id,
          rank: def.rank,
          scoring: def.scoring,
          ...(def.parKind ? { parKind: def.parKind } : {}),
          seeds: Array.from({ length: seedCount }, (_, i) => publicSeed(spec.id, def.id, i)),
        },
      ],
    },
  ],
};

process.stdout.write(JSON.stringify(suite, null, 2) + '\n');
