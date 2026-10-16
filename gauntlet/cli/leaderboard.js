/**
 * `gauntlet leaderboard`: score every agent found in the given run
 * directories against a suite manifest and render the JSON leaderboard plus
 * its Markdown, both through gauntlet/scoring/. Node-only.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaderboard } from '../scoring/leaderboard.js';
import { loadBaselineFile } from '../scoring/baselines.js';
import { resolveProfile } from '../scoring/profiles.js';
import { listGames } from '../games/index.js';
import { readSuiteFile } from './suite.js';
import { loadTrajectories } from './verify.js';
import { loadLeaderboardLadder } from './rate.js';

/** @import { Trajectory } from '../core/types.js' */
/** @import { ScoringBaseline } from '../scoring/profiles.js' */

/** The committed random baseline `chance-adjusted` rescales against. */
const DEFAULT_BASELINE_PATH = fileURLToPath(
  new URL('../scoring/baselines/random-public.json', import.meta.url)
);

/**
 * @typedef {object} LeaderboardOptions
 * @property {string} suitePath
 * @property {string[]} dirs Run directories (one `_run.json`-free dir per
 *   entry; multiple agents across directories are grouped by agent identity).
 * @property {string} [profile] Scoring profile id — one of `SCORING_PROFILES`
 *   (`rhae-v1`, `chance-adjusted`, `squared-outcome`). Defaults to `rhae-v1`,
 *   whose output is byte-identical to the pre-profiles scorer.
 * @property {ScoringBaseline} [baseline] Parsed scoring baseline for
 *   `chance-adjusted`; defaults to the committed random baseline
 *   (scoring/baselines/random-public.json).
 * @property {string} [baselineSha256] SHA-256 hex of the baseline file's
 *   bytes; defaults to the committed file's hash when the baseline is
 *   loaded here.
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
  // resolveProfile also validates an explicit --scoring-profile at this
  // boundary; only an explicitly selected profile is forwarded, so the
  // default board keeps its pre-profiles output byte-identical.
  const effectiveProfile = resolveProfile(options.profile);

  // chance-adjusted rescales every outcome tier against a random baseline;
  // the committed one is the default and the other profiles never read one.
  let baseline = options.baseline;
  let baselineSha256 = options.baselineSha256;
  if (effectiveProfile === 'chance-adjusted' && !baseline) {
    if (!existsSync(DEFAULT_BASELINE_PATH)) {
      throw new Error(
        `profile "chance-adjusted" needs a scoring baseline — expected the committed random baseline at ${DEFAULT_BASELINE_PATH} (build it with scoring/generate-baseline.js)`
      );
    }
    const loaded = loadBaselineFile(DEFAULT_BASELINE_PATH);
    baseline = loaded.baseline;
    baselineSha256 = loaded.sha256;
  }

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

  // The chess rating column is display-only: the ladder is loaded when the
  // package has one and silently omitted when it does not.
  const ratingLadder = loadLeaderboardLadder();

  const { leaderboard: board, markdown } = await leaderboard(suite, entries, listGames(), {
    ...(options.profile !== undefined ? { profile: effectiveProfile } : {}),
    ...(baseline ? { baseline } : {}),
    ...(typeof baselineSha256 === 'string' ? { baselineSha256 } : {}),
    ...(ratingLadder ? { ratingLadder } : {}),
  });

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
