/**
 * `gauntlet run`: execute one agent spec over a suite manifest through
 * `gauntlet/runs/` — the orchestration layer that owns worker concurrency,
 * budget caps, rate limiting, resume verification and the provenance record
 * (`run.json`). This CLI file is a thin adapter: it translates flags into an
 * engine invocation and the engine's result into output and an exit code.
 *
 * The suite manifest handed to the engine is a derived view of the one on
 * disk: `baseline:` specs scope it to their own game, and `--limit` slices
 * each tier's seeds. Deriving it deterministically means the manifest hash
 * recorded in `run.json` (and checked by `--resume` and `bundle verify`)
 * always describes exactly the episodes this command asked the engine to
 * play.
 *
 * Node-only.
 *
 * @module
 */

import { getGame } from '../games/index.js';
import { listGames } from '../games/index.js';
import { runSuite as runSuiteEngine } from '../runs/run.js';
import { findTier } from '../core/runner.js';
import { readSuiteFile } from './suite.js';
import { parseAgentSpec } from './agents.js';

/** @import { SuiteManifest } from '../scoring/suite.js' */
/** @import { ParseAgentSpecOptions } from './agents.js' */

/**
 * @typedef {object} CliRunOptions
 * @property {string} suitePath
 * @property {string} agentSpecText
 * @property {string} outDir
 * @property {number} [limit] Cap episodes per (game, tier): each tier's seed
 *   list is sliced to this many seeds in the derived manifest, so the limit
 *   is part of the recorded manifest hash.
 * @property {number} [maxInvalid] Ignored here: consecutive-invalid policy is
 *   the runner's (`play` still accepts it). Kept in the type so gauntlet.js
 *   can reject it explicitly for engine-backed runs.
 * @property {number} [concurrency] Worker count (default 1).
 * @property {number} [maxUsd] Hard dollar cap on summed usage.costUsd.
 * @property {number} [maxCalls] Hard cap on agent calls across the run.
 * @property {number} [requestsPerMinute] Shared rate limit on agent calls.
 * @property {boolean} [resume] Verify existing trajectory files and skip
 *   them; replay only missing or unverifiable ones.
 * @property {AbortSignal} [signal] Abort signal; a signalled run stops after
 *   the calls in flight and writes its provenance record.
 * @property {boolean} [dryRun] --dry-run (model specs).
 * @property {string} [prices] --prices file (model specs).
 * @property {string} [script] --script file (model specs).
 * @property {string} [baseUrl] --base-url (openai-chat provider).
 * @property {string} [apiKeyEnv] --api-key-env: the environment variable
 *   holding the provider API key.
 */

/**
 * The manifest the engine will actually play: the on-disk manifest with
 * non-matching games removed (baseline-scoped specs) and each remaining
 * tier's seeds sliced to `limit`. Pure and deterministic — the same suite
 * file, spec and flags always derive the same manifest, so `--resume` and
 * `bundle verify` hashes match across invocations.
 *
 * @param {SuiteManifest} suite
 * @param {string | null} gameId Game an `baseline:` spec scopes to.
 * @param {number | undefined} limit
 * @returns {SuiteManifest}
 */
function deriveManifest(suite, gameId, limit) {
  /** @type {SuiteManifest} */
  const derived = structuredClone(suite);
  if (gameId) {
    derived.games = derived.games.filter((g) => g.id === gameId);
  }
  if (limit !== undefined) {
    for (const game of derived.games) {
      for (const tier of game.tiers) {
        tier.seeds = tier.seeds.slice(0, limit);
      }
    }
  }
  return derived;
}

/**
 * Run the agent spec over the suite through gauntlet/runs/. Returns the
 * engine's result so gauntlet.js can set the exit code from `stopped`.
 *
 * @param {CliRunOptions} options
 * @returns {Promise<import('../runs/run.js').RunSuiteResult>}
 */
export async function runSuite(options) {
  const suite = readSuiteFile(options.suitePath);
  const /** @type {ParseAgentSpecOptions} */ specOptions = {
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.prices ? { prices: options.prices } : {}),
    ...(options.script ? { script: options.script } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
  };
  const spec = await parseAgentSpec(options.agentSpecText, specOptions);
  const manifest = deriveManifest(suite, spec.gameId, options.limit);
  const games = listGames();
  // Fail fast on a game the manifest needs but the registry does not have.
  for (const game of manifest.games) getGame(game.id);

  return runSuiteEngine({
    suite: manifest,
    games,
    outDir: options.outDir,
    agentFactory: async (job) => {
      const game = getGame(job.gameId);
      const tier = findTier(game, job.tierId);
      const agentSeat =
        typeof game.agentSeat === 'function' ? game.agentSeat(tier, job.seed) : 0;
      return spec.createForEpisode({ game, tier, seed: job.seed, agentSeat });
    },
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.maxUsd !== undefined ? { maxUsd: options.maxUsd } : {}),
    ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}),
    ...(options.requestsPerMinute !== undefined
      ? { requestsPerMinute: options.requestsPerMinute }
      : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.prices ? { pricesPath: /** @type {string} */ (options.prices) } : {}),
  });
}

/**
 * Print the run's outcome. One line per count plus the stop verdict; the
 * full record lives in `<outDir>/run.json`.
 *
 * @param {import('../runs/run.js').RunSuiteResult} result
 * @returns {void}
 */
export function printRunSummary(result) {
  const { run } = result;
  const lines = [
    `suite    ${run.suite.id} (${run.suite.split}) — manifest ${run.suite.manifestSha256.slice(0, 12)}…`,
    `episodes ${run.counts.jobs} planned, ${run.counts.played} played, ${run.counts.skipped} skipped (verified on resume), ${run.counts.replayed} replayed, ${run.counts.unplayed} unplayed, ${run.counts.failed} failed`,
    `calls    ${run.calls}${run.limits.maxCalls !== null ? ` / cap ${run.limits.maxCalls}` : ''}`,
    `spend    ${Number.isFinite(run.spendUsd) ? `${run.spendUsd.toFixed(6)}` : 'unknown (no cost data)'}${run.limits.maxUsd !== null ? ` / cap ${run.limits.maxUsd}` : ''}`,
    `record   run.json (format ${run.format})`,
  ];
  if (result.stopped) {
    lines.push(`stopped  ${result.stopped} — ${result.stopReason ?? ''}`);
    lines.push(`resume   re-run the same command with --resume to continue this bundle`);
  } else if (run.counts.failed > 0) {
    lines.push(`failed   ${run.counts.failed} episode(s) errored — details in run.json; re-run with --resume to retry them`);
  } else {
    lines.push(`done     every planned episode has a trajectory`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}
