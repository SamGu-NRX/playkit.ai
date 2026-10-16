/**
 * Build the model-separation study's suite manifest:
 * `node build-suite.mjs [seedsPerTier]` (default 4).
 *
 * One tier per game — the short-episode, lowest-rank tiers the study fixes:
 * tictactoe/perfect-opponent, mastermind/classic, connect4/ladder-1,
 * sliding/p8, sokoban/two-box, minesweeper/beginner, cube/cube-5. Tier ranks
 * are renumbered 1..k per game because buildSuite requires consecutive ranks
 * and each game here contributes exactly one tier. Node-only.
 *
 * @module
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSuite } from '../../scoring/suite.js';
import { GAMES } from '../../games/index.js';

/** @type {Array<[string, string]>} Game id → tier id, in run order. */
const SELECTION = [
  ['tictactoe', 'perfect-opponent'],
  ['mastermind', 'classic'],
  ['connect4', 'ladder-1'],
  ['sliding', 'p8'],
  ['sokoban', 'two-box'],
  ['minesweeper', 'beginner'],
  ['cube', 'cube-5'],
];

const seedsPerTier = Number(process.argv[2] ?? '4');
if (!Number.isInteger(seedsPerTier) || seedsPerTier < 1 || seedsPerTier > 25) {
  throw new Error(`seedsPerTier must be an integer in [1, 25], got ${process.argv[2] ?? '(none)'}`);
}

/** @type {import('../../core/types.js').Game<*>[]} */
const games = SELECTION.map(([gameId, tierId]) => {
  const game = /** @type {import('../../core/types.js').Game<*>} */ (GAMES[gameId]);
  if (!game) throw new Error(`unknown game id "${gameId}"`);
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  if (!tier) {
    throw new Error(`game "${gameId}" has no tier "${tierId}"`);
  }
  // One tier per game: renumber its rank to 1 and cap the public seed count.
  // The game objects are immutable once registered, so copy.
  return {
    ...game,
    spec: {
      ...game.spec,
      tiers: [{ ...tier, rank: 1, publicSeeds: Math.min(tier.publicSeeds, seedsPerTier) }],
    },
  };
});

const manifest = buildSuite(games, {
  split: 'public',
  id: `gauntlet-public-model-separation-first${seedsPerTier}`,
});

// Beside the manifest (this file), never the caller's working directory:
// reproduce.sh runs from gauntlet/, and the study commands read the suite
// from this directory (Codex P1 on PR #43).
const out = fileURLToPath(new URL('./suite.public.json', import.meta.url));
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
const jobs = manifest.games.reduce((n, g) => n + g.tiers.reduce((m, t) => m + t.seeds.length, 0), 0);
process.stdout.write(`wrote ${out} — ${manifest.games.length} games, ${jobs} jobs, ${seedsPerTier} seeds/tier\n`);
for (const g of manifest.games) {
  process.stdout.write(`  ${g.id} v${g.version}: ${g.tiers.map((t) => `${t.id}(${t.seeds.length}, scoring=${t.scoring})`).join(' ')}\n`);
}
