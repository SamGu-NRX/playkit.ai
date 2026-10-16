/**
 * One cell worker: runs every seed of one (game, tier, p) cell through
 * `runEpisode` and writes one JSON line per episode — the full trajectory
 * plus a summary header — to the `--out` ndjson file. Invoked by
 * `run-study.mjs` as a child process; not a study artifact by itself.
 *
 * @module
 */

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import { GAMES } from '../../../games/index.js';
import { runEpisode } from '../../../core/runner.js';
import { createSkillDialAgent } from './dial.js';
import { engineExpertFor } from './experts.mjs';
import { seedList } from './config.mjs';

const args = /** @type {Record<string, string>} */ ({});
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)=(.+)$/.exec(arg);
  if (match) args[match[1]] = match[2];
}

const gameId = args.game ?? '';
const tierId = args.tier ?? '';
const p = Number(args.p ?? '');
const out = args.out ?? '';
if (!gameId || !tierId || !Number.isFinite(p) || !out) {
  console.error('run-cell: --game, --tier, --p and --out are all required');
  process.exit(1);
}

const game = GAMES[gameId];
if (!game) {
  console.error(`run-cell: unknown game "${gameId}"`);
  process.exit(1);
}
const tier = game.spec.tiers.find((t) => t.id === tierId);
if (!tier) {
  console.error(`run-cell: game "${gameId}" has no tier "${tierId}"`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });

const seeds = seedList(gameId, tierId);
let done = 0;
for (const seed of seeds) {
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const expert = engineExpertFor(gameId, { game, tier, seed, seat });
  const agent = createSkillDialAgent({ expert, p, episodeSeed: seed });
  const trajectory = await runEpisode({ game, tierId, seed, agent });
  const e = trajectory.end.outcome?.normalized?.[trajectory.agent.seat] ?? null;
  writeFileSync(out, `${JSON.stringify({
    header: { gameId, tierId, p, seed, e, endReason: trajectory.end.reason, agentActions: trajectory.end.agentActions, invalidActions: trajectory.end.invalidActions },
    trajectory,
  })}\n`, { flag: 'a' });
  done++;
  appendFileSync(out.replace(/\.ndjson$/, '.progress'), `${done}/${seeds.length}\n`);
}
console.log(`cell ${gameId}/${tierId} p=${p}: ${done} episodes -> ${out}`);
