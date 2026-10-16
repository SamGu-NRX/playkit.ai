/**
 * Bundle verification: re-check a run directory from the outside. Re-verifies
 * every trajectory with the core verifier, recomputes the entry score with
 * `scoring/score.js`, and checks that the manifest hash recorded in `run.json`
 * matches the `suite.json` shipped in the bundle — so anyone with the game
 * implementations can confirm a results bundle without trusting the runner
 * that produced it. Every mismatch is reported, never swallowed.
 *
 * @module
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { verifyTrajectory, TRAJECTORY_FORMAT } from '../core/trajectory.js';
import { score } from '../scoring/score.js';
import { SUITE_FORMAT } from '../scoring/suite.js';

import { RUN_FORMAT } from './run.js';
import { normalizeGames, planJobs } from './plan.js';
import { canonicalSha256, readJsonFile, trajectoryPath } from './fsutil.js';

/** @import { Game, Trajectory } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */
/** @import { Job } from './plan.js' */

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new Error(`[gauntlet/runs/bundle.js] ${step}: ${message}`);
}

/**
 * Recursively list files under a directory, as paths relative to it.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function listFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @typedef {object} TrajectoryVerdict
 * @property {string} key Job key `"<game>/<tier>/<seed>"`.
 * @property {boolean} ok
 * @property {string} [reason] Why the verdict failed.
 */

/**
 * @typedef {object} BundleReport
 * @property {boolean} ok True when every check passed.
 * @property {string} outDir
 * @property {{ id: string, split: string, manifestSha256: string }} suite
 * @property {{ recorded: string | null, actual: string, ok: boolean }} manifestHash
 * @property {Record<string, *> | null} run The parsed run.json.
 * @property {TrajectoryVerdict[]} trajectories One verdict per planned job.
 * @property {string[]} stray Trajectory-format JSON files in the bundle that
 *   no planned job owns.
 * @property {Record<string, *> | null} score The recomputed entry score, or
 *   null when scoring refused.
 * @property {string | null} scoreError Why scoring refused.
 */

/**
 * Verify a results bundle produced by `runSuite`.
 *
 * @param {string} outDir The run directory (`suite.json`, `run.json` and the
 *   trajectory files inside it).
 * @param {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 *   Implementations for every suite game.
 * @returns {Promise<BundleReport>}
 */
export async function verifyBundle(outDir, games) {
  if (typeof outDir !== 'string' || outDir.length === 0) {
    refuse('outDir', 'must be a non-empty string');
  }
  const suiteParsed = await readJsonFile(path.join(outDir, 'suite.json'));
  if (!suiteParsed.ok) {
    refuse('suite', `no readable suite.json in ${outDir} (${suiteParsed.error}); not a run bundle`);
  }
  const suite = /** @type {SuiteManifest} */ (suiteParsed.value);
  if (!suite || suite.format !== SUITE_FORMAT) {
    refuse('suite', `suite.json is not a ${SUITE_FORMAT} manifest`);
  }
  const runParsed = await readJsonFile(path.join(outDir, 'run.json'));
  if (!runParsed.ok) {
    refuse('run', `no readable run.json in ${outDir} (${runParsed.error}); the run never finished writing provenance`);
  }
  const run = /** @type {Record<string, *>} */ (runParsed.value);
  if (run.format !== RUN_FORMAT) {
    refuse('run', `run.json format is ${JSON.stringify(run.format)}, expected ${RUN_FORMAT}`);
  }

  const gameMap = normalizeGames(games, suite);
  const jobs = planJobs(suite);
  const actualHash = canonicalSha256(suite);
  const recordedHash =
    /** @type {any} */ (run.suite)?.manifestSha256 ?? null;
  const manifestHashOk = typeof recordedHash === 'string' && recordedHash === actualHash;

  /** @type {TrajectoryVerdict[]} */
  const verdicts = [];
  /** @type {Trajectory[]} */
  const trajectories = [];
  /** @type {Set<string>} */
  const ownedPaths = new Set();
  for (const job of jobs) {
    const filePath = trajectoryPath(outDir, job);
    ownedPaths.add(path.relative(outDir, filePath));
    const parsed = await readJsonFile(filePath);
    if (!parsed.ok) {
      verdicts.push({ key: job.key, ok: false, reason: parsed.missing ? 'missing trajectory file' : `unreadable trajectory: ${parsed.error}` });
      continue;
    }
    const t = /** @type {any} */ (parsed.value);
    const identityOk =
      t &&
      t.format === TRAJECTORY_FORMAT &&
      t.game?.id === job.gameId &&
      t.tier === job.tierId &&
      t.seed === job.seed &&
      t.split === job.split;
    if (!identityOk) {
      verdicts.push({ key: job.key, ok: false, reason: 'trajectory contents do not match the planned job' });
      continue;
    }
    const verdict = await verifyTrajectory(/** @type {Game<*>} */ (gameMap.get(job.gameId)), t);
    if (verdict.ok) {
      verdicts.push({ key: job.key, ok: true });
      trajectories.push(/** @type {Trajectory} */ (t));
    } else {
      verdicts.push({ key: job.key, ok: false, reason: `verifyTrajectory (step ${verdict.step}): ${verdict.reason}` });
      trajectories.push(/** @type {Trajectory} */ (t));
    }
  }

  // Trajectory-format JSON files in the bundle that no planned job owns. A
  // non-trajectory JSON (estimate.json, run.json, suite.json) is not stray —
  // the bundle itself owns those.
  const knownTop = new Set(['suite.json', 'run.json', 'estimate.json', 'estimate.md']);
  const stray = [];
  for (const rel of await listFiles(outDir)) {
    if (knownTop.has(rel)) continue;
    if (ownedPaths.has(rel)) continue;
    if (!rel.endsWith('.json')) continue;
    const parsed = await readJsonFile(path.join(outDir, rel));
    if (parsed.ok && /** @type {any} */ (parsed.value)?.format === TRAJECTORY_FORMAT) {
      stray.push(rel);
    }
  }

  // Recompute the score over the bundle's trajectories — verified or not, so
  // scoring's own refusals name a tampered trajectory loudly.
  /** @type {Record<string, *> | null} */
  let scoreResult = null;
  /** @type {string | null} */
  let scoreError = null;
  const runAgent = /** @type {any} */ (run.agent);
  try {
    scoreResult = /** @type {Record<string, *>} */ (
      await score(
        suite,
        trajectories,
        gameMap,
        runAgent && typeof runAgent.id === 'string'
          ? {
              agent: {
                id: runAgent.id,
                track: runAgent.track,
                ...(runAgent.model !== undefined ? { model: runAgent.model } : {}),
                ...(runAgent.provider !== undefined ? { provider: runAgent.provider } : {}),
              },
            }
          : {}
      )
    );
  } catch (err) {
    scoreError = err instanceof Error ? err.message : String(err);
  }

  const ok =
    manifestHashOk && verdicts.every((v) => v.ok) && stray.length === 0 && scoreError === null;

  return {
    ok,
    outDir,
    suite: { id: suite.id, split: suite.split, manifestSha256: actualHash },
    manifestHash: { recorded: recordedHash, actual: actualHash, ok: manifestHashOk },
    run,
    trajectories: verdicts,
    stray,
    score: scoreResult,
    scoreError,
  };
}
