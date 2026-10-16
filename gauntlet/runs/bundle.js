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
import { verifyBridgeLog } from '../bridge/session-log.js';
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

/** Format of a `page/*.json` session log (see bridge/session-log.js). */
const BRIDGE_LOG_FORMAT = 'playkit-gauntlet-bridge-log/1';

/**
 * @typedef {object} PageSessionVerdict
 * @property {string} file Bundle-relative path, e.g. `page/11111.json`.
 * @property {boolean} ok
 * @property {number} [steps] Recorded steps, when the log verified.
 * @property {string} [reason] Why the verdict failed.
 */

/**
 * Verify every page session in a bundle: each `page/*.json` must be a
 * `playkit-gauntlet-bridge-log/1` log, and `verifyBridgeLog` must replay it.
 * `page/run.json` is the session-run provenance (written by `gauntlet page`),
 * not a session log, and is skipped; an unreadable or unknown-format JSON
 * under `page/` is a loud failure, never a silent skip.
 *
 * @param {string} outDir
 * @returns {Promise<PageSessionVerdict[]>}
 */
async function verifyPageSessions(outDir) {
  const pageDir = path.join(outDir, 'page');
  let entries;
  try {
    entries = await readdir(pageDir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {PageSessionVerdict[]} */
  const verdicts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'run.json') continue;
    const rel = `page/${entry.name}`;
    const parsed = await readJsonFile(path.join(pageDir, entry.name));
    if (!parsed.ok) {
      verdicts.push({ file: rel, ok: false, reason: `unreadable page session: ${parsed.error}` });
      continue;
    }
    const value = /** @type {any} */ (parsed.value);
    if (!value || value.format !== BRIDGE_LOG_FORMAT) {
      verdicts.push({ file: rel, ok: false, reason: `not a ${BRIDGE_LOG_FORMAT} log` });
      continue;
    }
    const checked = verifyBridgeLog(value);
    if (checked.ok) {
      verdicts.push({ file: rel, ok: true, steps: value.steps.length });
    } else {
      verdicts.push({ file: rel, ok: false, reason: `verifyBridgeLog (step ${checked.index}): ${checked.reason}` });
    }
  }
  return verdicts;
}

/**
 * @typedef {object} BundleReport
 * @property {boolean} ok True when every check passed.
 * @property {string} outDir
 * @property {{ id: string, split: string, manifestSha256: string }} suite
 * @property {{ recorded: string | null, actual: string, ok: boolean }} manifestHash
 * @property {Record<string, *> | null} run The parsed run.json.
 * @property {TrajectoryVerdict[]} trajectories One verdict per planned job.
 * @property {PageSessionVerdict[]} pageSessions One verdict per `page/*.json`
 *   session log, verified with `verifyBridgeLog` — reported separately from
 *   trajectories (a live page is unseeded and never scores).
 * @property {boolean} pageOnly True when the bundle holds page sessions but
 *   no suite manifest/run provenance — a standalone `gauntlet page` bundle.
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
    // No suite.json: a standalone `gauntlet page` bundle (page sessions plus
    // page/run.json, no run manifest) is still verifiable — page sessions
    // only, nothing else to check. Without any page session this is just not
    // a run bundle.
    const pageSessions = await verifyPageSessions(outDir);
    if (pageSessions.length > 0) {
      const strayPageOnly = [];
      for (const rel of await listFiles(outDir)) {
        if (rel.startsWith('page/')) continue;
        if (!rel.endsWith('.json')) continue;
        const parsed = await readJsonFile(path.join(outDir, rel));
        if (parsed.ok && /** @type {any} */ (parsed.value)?.format === TRAJECTORY_FORMAT) {
          strayPageOnly.push(rel);
        }
      }
      return {
        ok: pageSessions.every((v) => v.ok) && strayPageOnly.length === 0,
        outDir,
        suite: { id: '', split: '', manifestSha256: '' },
        manifestHash: { recorded: null, actual: '', ok: true },
        run: null,
        trajectories: [],
        pageSessions,
        pageOnly: true,
        stray: strayPageOnly,
        score: null,
        scoreError: null,
      };
    }
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

  // Page sessions live beside trajectories in a full bundle (a `gauntlet run`
  // bundle `gauntlet page` wrote into); they never score and are reported
  // separately.
  const pageSessions = await verifyPageSessions(outDir);

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
    manifestHashOk && verdicts.every((v) => v.ok) && pageSessions.every((v) => v.ok) && stray.length === 0 && scoreError === null;

  return {
    ok,
    outDir,
    suite: { id: suite.id, split: suite.split, manifestSha256: actualHash },
    manifestHash: { recorded: recordedHash, actual: actualHash, ok: manifestHashOk },
    run,
    trajectories: verdicts,
    pageSessions,
    pageOnly: false,
    stray,
    score: scoreResult,
    scoreError,
  };
}
