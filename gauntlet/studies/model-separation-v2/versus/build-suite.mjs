/**
 * Build the model-separation-v2 versus study's suite manifest:
 * `node build-suite.mjs <seedsPerTier> [--out=<file>]`.
 *
 * Two-player tiers built for weak agents (wave 11): tictactoe/random-opponent,
 * tictactoe/blunder-opponent, connect4/ladder-1, connect4/ladder-0. Both tiers
 * of a game are kept with their natural (consecutive) ranks; each tier's
 * public seed list is capped at `seedsPerTier` starting from seed 0.
 *
 * Node-only.
 *
 * @module
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSuite } from '../../../scoring/suite.js';
import { GAMES } from '../../../games/index.js';

/** @type {Array<[string, string[]]>} Game id → tier ids, in run order. */
const SELECTION = [
  ['tictactoe', ['random-opponent', 'blunder-opponent']],
  ['connect4', ['ladder-1', 'ladder-0']],
];

const seedsPerTier = Number(process.argv[2]);
if (!Number.isInteger(seedsPerTier) || seedsPerTier < 1 || seedsPerTier > 25) {
  throw new Error(`usage: node build-suite.mjs <seedsPerTier 1..25> [--out=<file>]`);
}
const outArg = process.argv.find((a) => a.startsWith('--out='));
const out = outArg
  ? fileURLToPath(new URL(outArg.slice(6), import.meta.url))
  : fileURLToPath(new URL(`./suite.public.json`, import.meta.url));

/** @type {import('../../core/types.js').Game<*>[]} */
const games = SELECTION.map(([gameId, tierIds]) => {
  const game = /** @type {import('../../core/types.js').Game<*>} */ (GAMES[gameId]);
  if (!game) throw new Error(`unknown game id "${gameId}"`);
  const tiers = tierIds.map((tierId) => {
    const tier = game.spec.tiers.find((t) => t.id === tierId);
    if (!tier) throw new Error(`game "${gameId}" has no tier "${tierId}"`);
    return { ...tier, publicSeeds: Math.min(tier.publicSeeds, seedsPerTier) };
  });
  const ranks = tiers.map((t) => t.rank).sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) {
      throw new Error(`tiers ${tierIds.join(',')} ranks not consecutive: ${ranks.join(',')}`);
    }
  }
  // The game objects are immutable once registered, so copy.
  return { ...game, spec: { ...game.spec, tiers } };
});

const manifest = buildSuite(games, {
  split: 'public',
  id: `gauntlet-public-model-separation-v2-versus-s${seedsPerTier}`,
});

writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
const jobs = manifest.games.reduce((n, g) => n + g.tiers.reduce((m, t) => m + t.seeds.length, 0), 0);
process.stdout.write(`wrote ${out} — ${manifest.games.length} games, ${jobs} jobs, ${seedsPerTier} seeds/tier\n`);
for (const g of manifest.games) {
  process.stdout.write(`  ${g.id} v${g.version}: ${g.tiers.map((t) => `${t.id}(rank${t.rank}, ${t.seeds.length}, ${t.scoring})`).join(' ')}\n`);
}
