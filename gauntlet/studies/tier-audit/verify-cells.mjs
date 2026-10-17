#!/usr/bin/env node
/**
 * Verify every audit cell bundle: run.json manifest matches the study suite,
 * every trajectory passes verifyTrajectory (the same verifier
 * `gauntlet verify` uses), and the bundle carries exactly the planned seeds.
 *
 * `gauntlet bundle verify` is not applicable here: it recomputes a benchmark
 * score, and score() refuses suites with no benchmark games — every audit
 * cell is a single-tier study-local suite, most of them non-benchmark games
 * (the skill-dial solo study verified the same way for the same reason).
 *
 * @module
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GAMES } from '../../games/index.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { auditDir, seedsForTier } from './audit-lib.mjs';
import { CELL_KINDS } from './audit-lib.mjs';

const root = auditDir();

let bundles = 0;
let trajectories = 0;
/** @type {string[]} */
const failures = [];

for (const [gameId, game] of Object.entries(GAMES)) {
  for (const tier of game.spec.tiers) {
    const seeds = seedsForTier(gameId, tier);
    for (const cell of CELL_KINDS) {
      const bundle = join(root, 'bundles', gameId, tier.id, cell);
      let run;
      try {
        run = JSON.parse(await readFile(join(bundle, 'run.json'), 'utf8'));
      } catch {
        continue; // cell not run (e.g. solo-reused dial) — compute-tiers accounts for it
      }
      bundles += 1;
      const expected = new Set(seeds);
      const seen = new Set();
      const dir = join(bundle, gameId, tier.id);
      /** @type {string[]} */
      let files = [];
      try {
        files = await readdir(dir);
      } catch {
        failures.push(`${gameId}/${tier.id}/${cell}: no trajectory directory`);
      }
      for (const f of files) {
        if (!f.endsWith('.json') || f === 'run.json') continue;
        const seed = f.slice(0, -'.json'.length);
        if (!expected.has(seed)) {
          failures.push(`${gameId}/${tier.id}/${cell}: stray trajectory ${seed}`);
          continue;
        }
        seen.add(seed);
        let trajectory;
        try {
          trajectory = JSON.parse(await readFile(join(dir, f), 'utf8'));
        } catch (err) {
          failures.push(`${gameId}/${tier.id}/${cell}/${seed}: unreadable (${err.message})`);
          continue;
        }
        const verdict = await verifyTrajectory(game, trajectory);
        if (verdict !== true) {
          failures.push(`${gameId}/${tier.id}/${cell}/${seed}: replay verify failed`);
          continue;
        }
        trajectories += 1;
      }
      for (const seed of expected) {
        if (!seen.has(seed)) failures.push(`${gameId}/${tier.id}/${cell}: missing trajectory ${seed}`);
      }
    }
  }
}

console.log(`verified ${trajectories} trajectories in ${bundles} bundles`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('all bundles replay-verified, no strays, no gaps');
