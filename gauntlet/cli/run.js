/**
 * `gauntlet run`: execute one agent spec over a suite manifest, writing one
 * trajectory file per episode plus a `_run.json` summary. Node-only.
 *
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEpisode } from '../core/runner.js';
import { findTier } from '../core/runner.js';
import { getGame } from '../games/index.js';
import { readSuiteFile } from './suite.js';
import { parseAgentSpec } from './agents.js';

/** @import { Trajectory } from '../core/types.js' */
/** @import { SuiteManifest, SuiteGame, SuiteTier } from '../scoring/suite.js' */
/** @import { AgentSpec } from './agents.js' */

/**
 * @typedef {object} RunOptions
 * @property {string} suitePath
 * @property {string} agentSpecText
 * @property {string} outDir
 * @property {number} [limit] Cap episodes per (game, tier). Default: every
 *   seed in the manifest. A run under the cap scores, but covers less than
 *   the full manifest, so the leaderboard marks it unranked.
 * @property {number} [maxInvalid] Consecutive invalid attempts before forfeit.
 * @property {boolean} [dryRun] --dry-run (model specs).
 * @property {string} [prices] --prices file (model specs).
 * @property {string} [script] --script file (model specs).
 */

/**
 * @typedef {object} RunEpisodeSummary
 * @property {string} file
 * @property {string} game
 * @property {string} tier
 * @property {string} seed
 * @property {number} seat
 * @property {string} end
 * @property {number} agentActions
 * @property {number} invalidActions
 * @property {number | null} score The agent's normalized episode score for
 *   outcome tiers; null for efficiency tiers (their episode score needs the
 *   solved flag and par — read from the trajectory).
 * @property {boolean} [solved]
 * @property {number} [par]
 */

/**
 * Run every episode the manifest asks of the agent.
 *
 * @param {RunOptions} options
 * @returns {Promise<{ agent: string, suite: string, split: string, outDir: string, episodes: RunEpisodeSummary[] }>}
 */
export async function runSuite(options) {
  const suite = readSuiteFile(options.suitePath);
  const spec = await parseAgentSpec(options.agentSpecText, {
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.prices ? { prices: options.prices } : {}),
    ...(options.script ? { script: options.script } : {}),
  });
  mkdirSync(options.outDir, { recursive: true });

  /** @type {RunEpisodeSummary[]} */
  const summaries = [];
  const startedAt = new Date().toISOString();

  for (const suiteGame of /** @type {SuiteGame[]} */ (suite.games)) {
    if (spec.gameId && suiteGame.id !== spec.gameId) continue;
    const game = getGame(suiteGame.id);
    for (const suiteTier of /** @type {SuiteTier[]} */ (suiteGame.tiers)) {
      const seeds = suiteTier.seeds;
      const count = options.limit !== undefined ? Math.min(options.limit, seeds.length) : seeds.length;
      for (let index = 0; index < count; index++) {
        const seed = seeds[index];
        const tier = findTier(game, suiteTier.id);
        const agentSeat =
          typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
        const agent = await spec.createForEpisode({ game, tier, seed, agentSeat });
        const trajectory = await runEpisode({
          game,
          tierId: suiteTier.id,
          seed,
          split: suite.split,
          agent,
          ...(options.maxInvalid !== undefined
            ? { maxConsecutiveInvalid: options.maxInvalid }
            : {}),
        });
        const file = `${suiteGame.id}__${suiteTier.id}__${index}.json`;
        writeFileSync(join(options.outDir, file), JSON.stringify(trajectory, null, 2) + '\n');
        const outcome = trajectory.end.outcome;
        const score =
          outcome && tier.scoring === 'outcome'
            ? /** @type {number} */ (outcome.normalized[agentSeat])
            : null;
        summaries.push({
          file,
          game: suiteGame.id,
          tier: suiteTier.id,
          seed,
          seat: agentSeat,
          end: trajectory.end.reason,
          agentActions: trajectory.end.agentActions,
          invalidActions: trajectory.end.invalidActions,
          score,
          ...(outcome && typeof outcome.solved === 'boolean' ? { solved: outcome.solved } : {}),
          ...(outcome && typeof outcome.par === 'number' ? { par: outcome.par } : {}),
        });
        process.stdout.write(
          `ran ${suiteGame.id}/${suiteTier.id} seed ${seed} — ${trajectory.end.reason}, ` +
            `${trajectory.end.agentActions} agent actions (${trajectory.end.invalidActions} invalid)\n`
        );
      }
    }
  }

  const summary = {
    agent: spec.text,
    suite: suite.id,
    split: suite.split,
    outDir: options.outDir,
    episodes: summaries,
  };
  writeFileSync(
    join(options.outDir, '_run.json'),
    JSON.stringify({ ...summary, startedAt, finishedAt: new Date().toISOString() }, null, 2) + '\n'
  );
  return summary;
}
