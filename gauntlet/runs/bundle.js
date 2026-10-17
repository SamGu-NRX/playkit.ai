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

import { RUN_FORMAT, readSpendLedger, SPEND_LEDGER_FILENAME } from './run.js';
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
 * @property {{ present: boolean, ok: boolean, problems: string[], invocations: number, calls: number, cap: number | null, totalUsd: number, keptUsd: number, unwoundUsd: number, unwoundCalls: number, unknownCalls: number, trajectoryUsd: number } | null} ledger
 *   The spend-ledger verdict, or null for a page-only bundle.
 */

/**
 * Verify a bundle's spend ledger against its trajectories. The ledger is
 * evidence, not authentication: the hash chain catches naive edits, and what
 * even a full re-chain cannot fake is the trajectories — every usage-carrying
 * agent step inside a kept episode must be accounted for, cost for cost and in
 * order, by a kept ledger line naming that job, and the ledger's recorded
 * total must cover the trajectories' spend (unwound and rejected calls make it
 * strictly larger). A bundle from before the ledger has none, and verifies
 * without one.
 *
 * @param {string} outDir
 * @param {Job[]} jobs
 * @returns {Promise<{ present: boolean, ok: boolean, problems: string[], invocations: number, calls: number, cap: number | null, totalUsd: number, keptUsd: number, unwoundUsd: number, unwoundCalls: number, unknownCalls: number, trajectoryUsd: number }>} 
 */
async function verifyBundleSpendLedger(outDir, jobs) {
  const ledger = await readSpendLedger(outDir);
  /** @type {string[]} */
  const problems = [...ledger.problems];
  if (!ledger.present) {
    return {
      present: false,
      ok: true,
      problems: [],
      invocations: 0,
      calls: 0,
      cap: null,
      totalUsd: 0,
      keptUsd: 0,
      unwoundUsd: 0,
      unwoundCalls: 0,
      unknownCalls: 0,
      trajectoryUsd: 0,
    };
  }

  // Agent-seat usage spend per job, walked from the trajectory files so a
  // re-chained ledger edit that also rewrote run.json totals still has to
  // agree with the trajectories themselves.
  let trajectoryUsd = 0;
  for (const job of jobs) {
    const parsed = await readJsonFile(trajectoryPath(outDir, job));
    if (!parsed.ok) continue; // a missing trajectory is the trajectory verdicts' finding
    const t = /** @type {any} */ (parsed.value);
    if (!t || t.format !== TRAJECTORY_FORMAT || !Array.isArray(t.steps)) continue;
    const usageSteps = t.steps.filter((/** @type {any} */ s) => s?.usage && (s.by === undefined || s.by === 'agent'));
    const keptUsageLines = ledger.lines
      .map((l) => l.value)
      .filter((v) => v && v.kind === 'call' && v.kept === true && v.job === job.key && v.usage === true);
    // A kept episode may carry MORE kept usage lines than its trajectory has
    // usage steps: when an episode time limit ends the episode mid-call, the
    // runner discards the late reply, but the provider still billed the call
    // and the ledger records that spend on the kept episode. The reverse — a
    // trajectory step with no kept ledger line — is always a problem.
    if (usageSteps.length > keptUsageLines.length) {
      problems.push(
        `${job.key}: ${usageSteps.length - keptUsageLines.length} trajectory usage step(s) are not covered by a kept ledger line (the kept ledger lines account for ${keptUsageLines.length})`
      );
      continue;
    }
    for (let i = 0; i < usageSteps.length; i++) {
      const lineCost = keptUsageLines[i].costUsd;
      const stepCost = usageSteps[i].usage?.costUsd;
      const lineFinite = typeof lineCost === 'number' && Number.isFinite(lineCost);
      const stepFinite = typeof stepCost === 'number' && Number.isFinite(stepCost);
      const matches =
        lineFinite && stepFinite
          ? Math.abs(lineCost - stepCost) <= 1e-9 + 1e-9 * Math.abs(lineCost)
          : !lineFinite && !stepFinite;
      if (!matches) {
        problems.push(
          `${job.key}: trajectory step ${i} is not covered by a kept ledger line (ledger ${JSON.stringify(lineCost)}, trajectory ${JSON.stringify(stepCost)})`
        );
      }
      if (stepFinite) trajectoryUsd += /** @type {number} */ (stepCost);
    }
  }

  if (ledger.summary.totalUsd + 1e-9 < trajectoryUsd) {
    problems.push(
      `the ledger's recorded total (${ledger.summary.totalUsd}) is below the trajectories' own spend (${trajectoryUsd})`
    );
  }

  return {
    present: true,
    ok: problems.length === 0,
    problems,
    invocations: ledger.summary.invocations,
    calls: ledger.summary.calls,
    cap: ledger.summary.cap,
    totalUsd: ledger.summary.totalUsd,
    keptUsd: ledger.summary.keptUsd,
    unwoundUsd: ledger.summary.unwoundUsd,
    unwoundCalls: ledger.summary.unwoundCalls,
    unknownCalls: ledger.summary.unknownCalls,
    trajectoryUsd,
  };
}

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
        ledger: null,
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

  // Completeness is the pre-existing contract — every planned job needs a
  // trajectory — so an incomplete (budget-stopped, not-yet-resumed) bundle
  // still fails verify; resume it to completion first. The ledger walk below
  // merely tolerates the missing files when it cross-checks coverage.

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

  // The spend ledger: hash chain, call shape, and — what a re-chain cannot
  // fake — coverage of every kept episode's usage-carrying agent steps.
  const ledger = await verifyBundleSpendLedger(outDir, jobs);

  const ok =
    manifestHashOk &&
    verdicts.every((v) => v.ok) &&
    pageSessions.every((v) => v.ok) &&
    stray.length === 0 &&
    scoreError === null &&
    ledger.ok;

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
    ledger,
  };
}
