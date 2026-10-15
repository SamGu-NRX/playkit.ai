/**
 * `gauntlet verify`: replay-verify one trajectory file or every trajectory in
 * a directory (`*.json` that is not a `_run.json` summary). Exit code 1 when
 * anything fails. Node-only.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTrajectory } from '../core/trajectory.js';
import { getGame } from '../games/index.js';

/** @import { Trajectory } from '../core/types.js' */

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
    isDir = readdirSync(target).length >= 0;
  } catch {
    isDir = false;
  }

  /** @type {string[]} */
  const paths = isDir
    ? readdirSync(target)
        .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
        .sort()
        .map((name) => join(target, name))
    : [target];
  if (paths.length === 0) {
    throw new Error(`"${target}" holds no trajectory files (*.json, excluding _run.json)`);
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
