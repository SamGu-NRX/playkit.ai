/**
 * `gauntlet verify`: replay-verify one trajectory file or every trajectory in
 * a directory — recursively, so both the legacy flat layout and the
 * engine-written bundle layout (`<game>/<tier>/<seed>.json`) work. Bundle
 * Bundle metadata (`run.json`, `suite.json`, `estimate.json`/`estimate.md`,
 * `_`-prefixed summaries) is skipped.
 * Exit code 1 when anything fails. Node-only.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTrajectory } from '../core/trajectory.js';
import { getGame } from '../games/index.js';

/** @import { Trajectory } from '../core/types.js' */

/** The bundle metadata files a run directory holds besides its trajectories. */
const METADATA_NAMES = new Set(['run.json', 'suite.json', 'estimate.json', 'estimate.md']);

/**
 * Collect trajectory files under a path: `*.json` files that are not bundle
 * metadata or `_`-prefixed summaries, recursing into subdirectories.
 * Exported for cli/leaderboard.js, which reads the same directories.
 *
 * @param {string} root
 * @param {string[]} out Accumulator.
 * @returns {void}
 */
export function collectJsonFiles(root, out) {
  const stats = statSync(root);
  if (!stats.isDirectory()) {
    out.push(root);
    return;
  }
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      collectJsonFiles(path, out);
      continue;
    }
    if (!name.endsWith('.json') || name.startsWith('_') || METADATA_NAMES.has(name)) continue;
    out.push(path);
  }
}

/**
 * @param {string} raw
 * @returns {Trajectory}
 */
function readTrajectory(raw) {
  const parsed = /** @type {*} */ (JSON.parse(raw));
  if (!parsed || !parsed.game || typeof parsed.game.id !== 'string') {
    throw new Error('not a gauntlet trajectory: missing game.id');
  }
  return /** @type {Trajectory} */ (parsed);
}

/**
 * @typedef {object} VerifyReport
 * @property {number} total
 * @property {number} ok
 * @property {string[]} failures
 */

/**
 * Verify one file or a directory of trajectories.
 *
 * @param {string} target File or directory.
 * @returns {Promise<VerifyReport>}
 */
export async function verifyPath(target) {
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    isDir = false;
  }

  /** @type {string[]} */
  const paths = [];
  if (isDir) {
    collectJsonFiles(target, paths);
  } else {
    paths.push(target);
  }
  if (paths.length === 0) {
    throw new Error(`"${target}" holds no trajectory files (*.json, excluding run.json/suite.json and _-prefixed summaries)`);
  }

  /** @type {VerifyReport} */
  const report = { total: 0, ok: 0, failures: [] };
  for (const path of paths) {
    report.total++;
    let trajectory;
    try {
      trajectory = readTrajectory(readFileSync(path, 'utf8'));
    } catch (err) {
      report.failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const game = getGame(trajectory.game.id);
    const verdict = await verifyTrajectory(game, trajectory);
    if (verdict.ok) {
      report.ok++;
      process.stdout.write(
        `ok   ${path} — ${trajectory.game.id}/${trajectory.tier} seed ${trajectory.seed} ` +
          `(${trajectory.steps.length} steps, end ${trajectory.end.reason})\n`
      );
    } else {
      report.failures.push(`${path}: step ${verdict.step}: ${verdict.reason}`);
    }
  }
  for (const failure of report.failures) {
    process.stderr.write(`FAIL ${failure}\n`);
  }
  process.stdout.write(`${report.ok}/${report.total} trajectories verified\n`);
  return report;
}

void readTrajectory;
