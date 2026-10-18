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
import { manifestSha256 } from '../../runs/plan.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { auditDir, seedsForTier, tierSuite } from './audit-lib.mjs';
import { runRecordFailures } from './audit-lib.mjs';
import { CELL_KINDS } from './audit-lib.mjs';

const root = auditDir();

/**
 * Every .json file under `dir`, as slash-separated paths relative to it.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const rel of await walk(join(dir, entry.name))) out.push(`${entry.name}/${rel}`);
    } else if (entry.name.endsWith('.json') && entry.name !== 'run.json' && entry.name !== 'suite.json') {
      out.push(entry.name);
    }
  }
  return out;
}


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
      // The record must claim THIS cell's suite manifest and agent (Codex
      // #4301264696): a run.json from another cell or an older manifest
      // would otherwise pass seed/replay checks while describing a different
      // study.
      const { suite } = tierSuite(gameId, tier.id);
      for (const failure of runRecordFailures(run, cell, manifestSha256(suite))) {
        failures.push(`${gameId}/${tier.id}/${cell}: ${failure}`);
      }
      const expected = new Set(seeds);
      const seen = new Set();
      const dir = join(bundle, gameId, tier.id);
      /** Trajectories nest under the full seed path (game/tier/public/N.json
       * relative to the cell's game/tier directory). Walk recursively. */
      /** @type {string[]} */
      let rels = [];
      try {
        rels = await walk(dir);
      } catch (err) {
        failures.push(`${gameId}/${tier.id}/${cell}: no trajectory directory (${err.message})`);
      }
      for (const rel of rels) {
        const seed = rel.slice(0, -'.json'.length);
        if (!expected.has(seed)) {
          failures.push(`${gameId}/${tier.id}/${cell}: stray trajectory ${seed}`);
          continue;
        }
        seen.add(seed);
        let trajectory;
        try {
          trajectory = JSON.parse(await readFile(join(dir, rel), 'utf8'));
        } catch (err) {
          failures.push(`${gameId}/${tier.id}/${cell}/${seed}: unreadable (${err.message})`);
          continue;
        }
        const verdict = /** @type {*} */ (await verifyTrajectory(game, trajectory));
        if (!(verdict === true || verdict?.ok === true)) {
          failures.push(`${gameId}/${tier.id}/${cell}/${seed}: replay verify failed (${JSON.stringify(verdict).slice(0, 200)})`);
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
