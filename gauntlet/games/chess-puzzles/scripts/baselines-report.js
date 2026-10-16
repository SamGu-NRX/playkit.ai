#!/usr/bin/env node
/**
 * Baseline solve-rate report for chess-puzzles: runs the bundled chess
 * baselines (material-greedy and the fixed-strength engine baseline) over
 * every public seed of every tier through the full runner and prints a
 * markdown table. Node-only tooling; results go to stdout so they can be
 * pasted into the PR.
 *
 * Usage: node scripts/baselines-report.js [--agents=greedy,engine] [--limit=N]
 *
 * @module
 */

import { runEpisode } from '../../../core/runner.js';
import { createGreedyBaselineAgent, createEngineBaselineAgent } from '../../chess/baselines.js';
import { chessPuzzles } from '../index.js';
import { PUBLIC_SEEDS } from '../puzzles.js';
import { tierIds } from '../selection.js';

const AGENTS = ['greedy', 'engine'];
const argv = process.argv.slice(2);
const agentFlag = /** @type {string | undefined} */ (
  argv.find((arg) => arg.startsWith('--agents='))
);
const wanted = new Set(
  (agentFlag ? agentFlag.slice('--agents='.length).split(',') : AGENTS).map((name) => name.trim())
);
const limitFlag = argv.find((arg) => arg.startsWith('--limit='));
const limit = limitFlag ? Number(limitFlag.slice('--limit='.length)) : PUBLIC_SEEDS;
if (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_SEEDS) {
  throw new Error(`--limit must be an integer between 1 and ${PUBLIC_SEEDS}`);
}

/**
 * The agents to report, in fixed order.
 *
 * @returns {{ key: string, make: (tierId: string, seed: string) => import('../../../core/types.js').Agent }[]}
 */
function selectedAgents() {
  /** @type {{ key: string, make: (tierId: string, seed: string) => import('../../../core/types.js').Agent }[]} */
  const makers = [];
  if (wanted.has('greedy')) {
    makers.push({
      key: 'greedy (material-capture)',
      make: (tierId, seed) =>
        createGreedyBaselineAgent({ id: `greedy-${tierId}`, episodeSeed: `${tierId}/${seed}` }),
    });
  }
  if (wanted.has('engine')) {
    makers.push({
      key: 'engine (fixed strength)',
      make: (tierId, seed) => {
        const tier = /** @type {NonNullable<ReturnType<typeof chessPuzzles.spec.tiers.find>>} */ (
          chessPuzzles.spec.tiers.find((entry) => entry.id === tierId)
        );
        return createEngineBaselineAgent({ tier, seed, seat: 0, id: `engine-${tierId}` });
      },
    });
  }
  if (makers.length === 0) {
    throw new Error(`no known agents selected (wanted: ${[...wanted].join(', ')})`);
  }
  return makers;
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const makers = selectedAgents();
  /** @type {Map<string, { solved: number, total: number, episodes: { seed: string, solved: boolean, actions: number, reason: string }[] }>} */
  const results = new Map();
  for (const tierId of tierIds()) {
    for (const maker of makers) {
      const key = `${tierId} / ${maker.key}`;
      /** @type {{ solved: number, total: number, episodes: { seed: string, solved: boolean, actions: number, reason: string }[] }} */
      const entry = { solved: 0, total: 0, episodes: [] };
      results.set(key, entry);
      for (let index = 0; index < limit; index++) {
        const seed = `chess-puzzles/${tierId}/public/${index}`;
        const trajectory = await runEpisode({
          game: chessPuzzles,
          tierId,
          seed,
          agent: maker.make(tierId, seed),
        });
        const solved = trajectory.end.outcome?.normalized[0] === 1;
        entry.total++;
        if (solved) entry.solved++;
        entry.episodes.push({
          seed,
          solved,
          actions: trajectory.end.agentActions,
          reason: trajectory.end.reason,
        });
      }
      process.stderr.write(`${key}: ${entry.solved}/${entry.total}\n`);
    }
  }
  const lines = [
    '| Tier | Baseline | Solved | Solve rate |',
    '|---|---|---|---|',
  ];
  for (const tierId of tierIds()) {
    for (const maker of makers) {
      const key = `${tierId} / ${maker.key}`;
      const entry = /** @type {NonNullable<ReturnType<typeof results.get>>} */ (results.get(key));
      const rate = entry.total === 0 ? '0%' : `${((entry.solved / entry.total) * 100).toFixed(1)}%`;
      lines.push(`| ${tierId} | ${maker.key} | ${entry.solved}/${entry.total} | ${rate} |`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => {
  process.stderr.write(`baselines-report failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
