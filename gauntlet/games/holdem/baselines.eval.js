/**
 * Baseline evaluation for the hold'em game: runs each baseline (greedy,
 * engine) against each ranked tier opponent over the public seeds and prints
 * a markdown table of mean normalized score and mean bb100. Run from
 * `gauntlet/`:
 *
 *   node games/holdem/baselines.eval.js [matchesPerPair]
 *
 * Deterministic: every episode runs from a public seed with fixed opponents,
 * so the table reproduces exactly. No `node:*` imports beyond console use —
 * runEpisode is async and the agents are pure.
 *
 * @module
 */

import { holdem, GAME_ID } from './index.js';
import { makeBaseline } from './baselines.js';
import { runEpisode } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';

const matches = Number(process.argv[2] ?? 12);
const tiers = holdem.spec.tiers;
/** @type {('greedy' | 'engine')[]} */
const baselines = ['greedy', 'engine'];

/** @type {string[]} */
const rows = [];
const startedAt = Date.now();

for (const kind of baselines) {
  for (const tier of tiers) {
    let scoreSum = 0;
    let bb100Sum = 0;
    let wins = 0;
    let played = 0;
    for (let i = 0; i < matches; i++) {
      const seed = publicSeed(GAME_ID, tier.id, i);
      const agent = makeBaseline(kind, seed, 0);
      const trajectory = await runEpisode({ game: holdem, tierId: tier.id, seed, agent });
      const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
      const score = outcome.normalized[0];
      const chips = /** @type {number[]} */ (outcome.raw)[0];
      const bb100 = (chips / 2) * (100 / trajectoryStepsHands(trajectory));
      scoreSum += score;
      bb100Sum += bb100;
      if (score > 0.5) wins += 1;
      played += 1;
    }
    rows.push(
      `| ${kind} | ${tier.id} | ${played} | ${fmt(scoreSum / played)} | ${fmt(bb100Sum / played)} | ${wins}/${played} |`
    );
  }
}

/** @param {import('../../core/types.js').Trajectory} trajectory */
function trajectoryStepsHands(trajectory) {
  const reason = trajectory.end.outcome?.reason ?? '';
  const m = /(\d+) hands/.exec(reason);
  return m ? Number(m[1]) : 40;
}

/** @param {number} n */
function fmt(n) {
  return (n >= 0 ? '' : '') + n.toFixed(3);
}

console.log(`hold'em baselines over ${matches} matches per pair (duplicate matches, 40 hands each)`);
console.log('');
console.log('| baseline | tier | matches | mean normalized | mean bb100 | win record |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
console.log('');
console.log(`total wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
