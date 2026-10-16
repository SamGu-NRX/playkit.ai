/**
 * Baseline table generator for the Gauntlet 2048 game. Prints, per tier, the
 * mean normalized score and win fraction of the greedy and engine baselines
 * over 20 public seeds, plus the engine's mean time per move. Run from
 * `gauntlet/`:
 *
 *   node games/2048/benchmark.js
 *
 * This is tooling for the PR report, not part of the game contract.
 *
 * @module
 */

import { game } from './index.js';
import { greedy, engine } from './baselines.js';
import { runEpisode, findTier } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';

const SEEDS = 20;

/**
 * @param {string} tierId
 * @param {string} seed
 * @param {import('../../core/types.js').Agent} agent
 * @param {{ ms: number, moves: number }} timing
 * @returns {Promise<number>}
 */
async function play(tierId, seed, agent, timing) {
  const timedAgent = {
    ...agent,
    async act(/** @type {import('../../core/types.js').TurnContext} */ ctx) {
      const start = Date.now();
      const reply = await agent.act(ctx);
      timing.ms += Date.now() - start;
      timing.moves++;
      return reply;
    },
  };
  const trajectory = await runEpisode({ game, tierId, seed, agent: timedAgent });
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
  return outcome.normalized[0];
}

/**
 * @param {string} tierId
 * @param {import('../../core/types.js').Agent} agent
 * @returns {Promise<{ mean: number, wins: number, msPerMove: number }>}
 */
async function run(tierId, agent) {
  const tier = findTier(game, tierId);
  /** @type {number[]} */
  const scores = [];
  let wins = 0;
  const timing = { ms: 0, moves: 0 };
  for (let i = 0; i < SEEDS; i++) {
    const seed = publicSeed('2048', tierId, i);
    const score = await play(tier.id, seed, agent, timing);
    scores.push(score);
    if (score === 1) wins++;
  }
  return {
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    wins,
    msPerMove: timing.moves > 0 ? timing.ms / timing.moves : 0,
  };
}

/** @type {string[]} */
const rows = [];
for (const tier of game.spec.tiers) {
  const g = await run(tier.id, greedy());
  const e = await run(tier.id, engine());
  rows.push(
    `| ${tier.id} | ${g.mean.toFixed(4)} | ${(100 * g.wins) / SEEDS}% | ${e.mean.toFixed(4)} | ${(100 * e.wins) / SEEDS}% | ${e.msPerMove.toFixed(2)} |`
  );
}

console.log('| tier | greedy mean | greedy win | engine mean | engine win | engine ms/move |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) console.log(row);
