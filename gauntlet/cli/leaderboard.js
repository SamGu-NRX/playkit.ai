/**
 * `gauntlet leaderboard`: score every agent found in the given run
 * directories against a suite manifest and render the JSON leaderboard plus
 * its Markdown, both through gauntlet/scoring/. Node-only.
 *
 * @module
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaderboard } from '../scoring/leaderboard.js';
import { listGames } from '../games/index.js';
import { readSuiteFile } from './suite.js';

/** @import { Trajectory } from '../core/types.js' */

/**
 * Load every trajectory file (`*.json`, skipping `_run.json` summaries) from
 * the given directories, in order.
 *
 * @param {string[]} dirs
 * @returns {Trajectory[]}
 */
function loadTrajectories(dirs) {
  /** @type {Trajectory[]} */
  const trajectories = [];
  for (const dir of dirs) {
    const names = readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
      .sort();
    if (names.length === 0) {
      throw new Error(`"${dir}" holds no trajectory files (*.json, excluding _run.json)`);
    }
    for (const name of names) {
      const parsed = /** @type {*} */ (JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (!parsed || !parsed.game || typeof parsed.game.id !== 'string' || !Array.isArray(parsed.steps)) {
        throw new Error(`${join(dir, name)} is not a gauntlet trajectory`);
      }
      trajectories.push(/** @type {Trajectory} */ (parsed));
    }
  }
  return trajectories;
}

/**
 * @typedef {object} LeaderboardOptions
 * @property {string} suitePath
 * @property {string[]} dirs Run directories (one `_run.json`-free dir per
 *   entry; multiple agents across directories are grouped by agent identity).
 * @property {string} [outDir] When set, writes `leaderboard.json` and
 *   `leaderboard.md` there.
 * @property {boolean} [json] Print the JSON leaderboard to stdout (default
 *   prints the Markdown).
 */

/**
 * Build, print, and optionally write the leaderboard.
 *
 * @param {LeaderboardOptions} options
 * @returns {Promise<{ tracks: Record<string, number> }>} Per-track entry counts.
 */
export async function buildLeaderboard(options) {
  const suite = readSuiteFile(options.suitePath);
  const trajectories = loadTrajectories(options.dirs);

  // One entry per agent identity; score() refuses mixed identities.
  /** @type {Map<string, Trajectory[]>} */
  const byAgent = new Map();
  for (const trajectory of trajectories) {
    const key = `${trajectory.agent.id}\u0000${trajectory.agent.track}`;
    const bucket = byAgent.get(key);
    if (bucket) bucket.push(trajectory);
    else byAgent.set(key, [trajectory]);
  }

  const entries = [...byAgent.values()].map((list) => ({ agent: list[0].agent, trajectories: list }));
  const { leaderboard: board, markdown } = await leaderboard(suite, entries, listGames());

  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, 'leaderboard.json'), JSON.stringify(board, null, 2) + '\n');
    writeFileSync(join(options.outDir, 'leaderboard.md'), markdown + '\n');
    process.stdout.write(
      `wrote ${join(options.outDir, 'leaderboard.json')} and ${join(options.outDir, 'leaderboard.md')}\n`
    );
  } else if (options.json) {
    process.stdout.write(JSON.stringify(board, null, 2) + '\n');
  } else {
    process.stdout.write(markdown + '\n');
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const [track, list] of Object.entries(board.tracks)) {
    counts[track] = list.length;
  }
  return { tracks: counts };
}
