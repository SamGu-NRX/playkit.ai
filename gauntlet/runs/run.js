/**
 * The run engine: plays a whole suite with bounded concurrency, a shared
 * token-bucket rate limit, a hard dollar cap and a hard call cap, atomic
 * per-episode trajectory files, resume without replaying finished episodes,
 * and a `run.json` provenance record that makes the results bundle verifiable
 * by anyone with the games and the manifest.
 *
 * Node-only (`node:*` imports; the games it plays stay browser-safe).
 *
 * Budget and call-cap semantics: the shared counters are checked *before*
 * each agent call, so no call starts once a cap is reached. A quote-carrying
 * agent makes the dollar cap hold under concurrency: an agent exposing
 * `quoteWorstCaseUsd` (see core/types.js) prices its next call's worst case —
 * the request text at a conservative token estimate plus the output-token
 * limit — and the engine reserves that quote while the call is in flight,
 * admitting a call only when settled spend plus all outstanding reservations
 * plus the new quote fit under `maxUsd`. Realized spend therefore cannot
 * overshoot the cap; each reservation is settled to the provider's actual
 * reported usage when the call returns. Agents without a quote keep the
 * settled-only check: the cap is then enforced on completed calls only, and
 * concurrent in-flight calls can overshoot `maxUsd` by at most the cost of
 * the in-flight calls (one per worker). With `maxUsd` set, the first agent
 * step whose `usage.costUsd` is null stops the run with an error: a cap
 * cannot be enforced over unknown prices, and guessing would hide real spend.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { runEpisode } from '../core/runner.js';
import { verifyTrajectory, TRAJECTORY_FORMAT } from '../core/trajectory.js';
import { SUITE_FORMAT } from '../scoring/suite.js';

import { manifestSha256, normalizeGames, planJobs } from './plan.js';
import { atomicWriteFile, canonicalSha256, readJsonFile, sha256Hex, trajectoryPath } from './fsutil.js';

/** @import { Agent, AgentReply, Game, Trajectory, TurnContext } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */
/** @import { Job } from './plan.js' */

/** Provenance record format, written as `run.json`. */
export const RUN_FORMAT = 'playkit-gauntlet-run/1';

/**
 * @typedef {'budget' | 'calls' | 'cancelled' | 'error'} StopReason
 */

/**
 * Thrown by the budget-wrapped agent to abort the episode in flight. The
 * runner propagates agent `act` errors, so this unwinds the episode without
 * writing anything; the worker pool treats it as "stop the run".
 *
 * The reason is one of the run-level stop reasons: a cap was reached or the
 * caller's abort signal fired.
 */
export class RunAbortedError extends Error {
  /**
   * @param {StopReason} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'RunAbortedError';
    /** @type {StopReason} */
    this.reason = reason;
  }
}

/**
 * Thrown when `maxUsd` is set and an agent step reports no finite
 * `usage.costUsd`. Stops the whole run: the cap cannot be enforced without a
 * price entry for the model.
 */
export class UnknownCostError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'UnknownCostError';
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A token-bucket rate limiter shared by all workers: `requestsPerMinute`
 * request tokens, capacity one, so requests are spaced at least
 * `60000 / requestsPerMinute` ms apart. `now` and `sleep` are injectable so
 * tests can drive it under a fake clock.
 *
 * @typedef {object} RateLimiter
 * @property {() => Promise<void>} acquire Resolves when one request may start.
 */

/**
 * @param {object} options
 * @param {number} options.requestsPerMinute Positive.
 * @param {() => number} [options.now] Millisecond clock. Default Date.now.
 * @param {(ms: number) => Promise<void>} [options.sleep] Delay function.
 * @returns {RateLimiter}
 */
export function createRateLimiter({ requestsPerMinute, now = Date.now, sleep }) {
  if (typeof requestsPerMinute !== 'number' || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new Error(
      `createRateLimiter: requestsPerMinute must be a positive finite number, got ${JSON.stringify(requestsPerMinute)}`
    );
  }
  const interval = 60_000 / requestsPerMinute;
  const wait =
    sleep ??
    /** @type {(ms: number) => Promise<void>} */ ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /** One stored token to start: the first request never waits. */
  let tokens = 1;
  let last = now();
  // Concurrent acquirers are serialized through a promise chain so two
  // workers can never consume the same token.
  let chain = Promise.resolve();

  /** @returns {Promise<void>} */
  async function acquire() {
    for (;;) {
      const t = now();
      tokens = Math.min(1, tokens + (t - last) / interval);
      last = t;
      if (tokens >= 1 - 1e-9) {
        tokens = Math.max(0, tokens - 1);
        return;
      }
      await wait((1 - tokens) * interval);
    }
  }

  return {
    acquire() {
      const next = chain.then(acquire, acquire);
      chain = next.catch(() => {});
      return next;
    },
  };
}

/**
 * Git commit of the working tree, when `git` is available; null otherwise.
 * Never fatal: provenance is recorded when it can be, not invented.
 *
 * @returns {string | null}
 */
function gitCommit() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });
    const commit = out.trim();
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} RunAgentRecord
 * @property {string} id
 * @property {string} track
 * @property {string} [provider]
 * @property {string} [model]
 */

/**
 * @typedef {object} RunCounts
 * @property {number} jobs Planned episodes.
 * @property {number} played Trajectories written by this invocation.
 * @property {number} skipped Verified existing files, not re-run (resume).
 * @property {number} replayed Existing but unverifiable files, re-run.
 * @property {number} unplayed Still without a trajectory after this run.
 * @property {number} failed Episodes whose agent or game threw.
 */

/**
 * @typedef {object} RunRecord
 * @property {'playkit-gauntlet-run/1'} format
 * @property {{ id: string, split: string, manifestSha256: string }} suite
 * @property {{ commit: string | null }} git
 * @property {string} node Node version of the run.
 * @property {RunAgentRecord | null} agent
 * @property {{ sha256: string | null, path?: string }} prices
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} concurrency
 * @property {{ maxUsd: number | null, maxCalls: number | null, requestsPerMinute: number | null, maxOutputTokens: number | null, callTimeoutMs: number | null, thinkingBudget: number | null, reasoningEffort: string | null }} limits
 * @property {number} spendUsd Sum of the steps' known costs. A step that
 *   reported usage without a priced cost counts here as 0 and separately in
 *   unknownCostSteps — unknown stays unknown, it is never folded into 0.
 * @property {number} unknownCostSteps Steps whose reply carried usage with a
 *   null (or non-finite) costUsd: usage was reported, so the cost is unknown,
 *   not zero.
 * @property {number} calls
 * @property {RunCounts} counts
 * @property {string[]} skipped
 * @property {string[]} replayed
 * @property {string[]} unplayed
 * @property {{ key: string, error: string }[]} failed
 * @property {StopReason | null} stopped
 * @property {string | null} stopReason
 */

/**
 * @typedef {object} RunSuiteOptions
 * @property {SuiteManifest} suite The suite manifest to play.
 * @property {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 *   Implementations for every suite game.
 * @property {(job: Job) => Agent | Promise<Agent>} agentFactory
 *   Builds the agent for one episode. Called once per episode so per-episode
 *   agent state (a model agent's carried-over previous reply, a seeded
 *   baseline's RNG) resets; returning the same stateless instance is fine.
 * @property {string} outDir Results bundle directory, created if missing.
 * @property {number} [concurrency] Worker count. Default 1.
 * @property {number} [maxUsd] Hard dollar cap on summed usage.costUsd.
 * @property {number} [maxCalls] Hard cap on agent calls across the run.
 * @property {number} [requestsPerMinute] Shared rate limit on agent calls.
 * @property {number} [maxOutputTokens] Recorded in run.json's limits for
 *   provenance; the per-reply output cap itself is applied by the agent layer
 *   (the agent spec's --max-output-tokens).
 * @property {number} [callTimeoutMs] Recorded in run.json's limits for
 *   provenance; the per-attempt timeout itself is applied by the agent layer
 *   (the agent spec's --call-timeout-ms).
 * @property {number} [thinkingBudget] Recorded in run.json's limits for
 *   provenance; the Anthropic extended-thinking budget itself is applied by
 *   the agent layer (thinking.budget_tokens; the wire max_tokens is the reply
 *   cap plus this budget) and the worst-case cost quote includes it.
 * @property {'low' | 'medium' | 'high'} [reasoningEffort] Recorded in
 *   run.json's limits for provenance; the OpenAI reasoning effort itself is
 *   applied by the agent layer (reasoning.effort / reasoning_effort).
 * @property {boolean} [resume] Verify existing trajectory files and skip the
 *   verified ones. Default false.
 * @property {AbortSignal} [signal] Abort to stop after the calls in flight.
 * @property {PriceFileLike} [prices] Prices object; only its SHA-256 is
 *   recorded in run.json (cost enforcement reads the agent's own usage).
 * @property {string} [pricesPath] Prices file path; the file's SHA-256 is
 *   recorded. Takes precedence over `prices`.
 * @property {() => number} [now] Millisecond clock for timestamps.
 * @property {(ms: number) => Promise<void>} [sleep] Delay function.
 */

/**
 * Shape of a prices file: `Record<'<provider>/<model>', { inputPerMTok,
 * outputPerMTok, source, checked }>` (harness/model-agent.js PriceFile).
 *
 * @typedef {Record<string, any>} PriceFileLike
 */

/**
 * @typedef {object} RunSuiteResult
 * @property {RunRecord} run The provenance record written to run.json.
 * @property {Trajectory[]} trajectories Episodes completed by this invocation.
 * @property {string[]} skipped Verified existing files, not re-run.
 * @property {string[]} replayed Unverifiable existing files, re-run.
 * @property {string[]} unplayed Keys still unplayed after this invocation.
 * @property {{ key: string, error: string }[]} failed
 * @property {StopReason | null} stopped
 * @property {string | null} stopReason
 * @property {number} spendUsd Known-cost sum; see RunRecord.
 * @property {number} unknownCostSteps Steps with usage but unknown cost.
 * @property {number} calls
 */

/**
 * Run a whole suite.
 *
 * @param {RunSuiteOptions} options
 * @returns {Promise<RunSuiteResult>}
 * @throws {UnknownCostError} when `maxUsd` is set and an agent step reports a
 *   null costUsd — after writing run.json, so the partial bundle stays
 *   resumable.
 */
export async function runSuite({
  suite,
  games,
  agentFactory,
  outDir,
  concurrency = 1,
  maxUsd,
  maxCalls,
  requestsPerMinute,
  maxOutputTokens,
  callTimeoutMs,
  thinkingBudget,
  reasoningEffort,
  resume = false,
  signal,
  prices,
  pricesPath,
  now = Date.now,
  sleep,
}) {
  if (!suite || suite.format !== SUITE_FORMAT) {
    throw new Error(
      `[gauntlet/runs/run.js] suite: expected a ${SUITE_FORMAT} manifest, got ${JSON.stringify(suite && /** @type {*} */ (suite).format)}`
    );
  }
  if (typeof agentFactory !== 'function') {
    throw new Error('[gauntlet/runs/run.js] agentFactory: must be a function');
  }
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new Error('[gauntlet/runs/run.js] outDir: must be a non-empty string');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`[gauntlet/runs/run.js] concurrency: must be an integer >= 1, got ${JSON.stringify(concurrency)}`);
  }
  if (maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new Error(`[gauntlet/runs/run.js] maxUsd: must be a positive finite number, got ${JSON.stringify(maxUsd)}`);
  }
  if (maxCalls !== undefined && (!Number.isInteger(maxCalls) || maxCalls < 1)) {
    throw new Error(`[gauntlet/runs/run.js] maxCalls: must be a positive integer, got ${JSON.stringify(maxCalls)}`);
  }
  if (
    requestsPerMinute !== undefined &&
    (typeof requestsPerMinute !== 'number' || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0)
  ) {
    throw new Error(
      `[gauntlet/runs/run.js] requestsPerMinute: must be a positive finite number, got ${JSON.stringify(requestsPerMinute)}`
    );
  }
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new Error(
      `[gauntlet/runs/run.js] maxOutputTokens: must be a positive integer, got ${JSON.stringify(maxOutputTokens)}`
    );
  }
  if (callTimeoutMs !== undefined && (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 1)) {
    throw new Error(
      `[gauntlet/runs/run.js] callTimeoutMs: must be a positive integer, got ${JSON.stringify(callTimeoutMs)}`
    );
  }
  if (thinkingBudget !== undefined && (!Number.isInteger(thinkingBudget) || thinkingBudget < 1)) {
    throw new Error(
      `[gauntlet/runs/run.js] thinkingBudget: must be a positive integer (the agent layer enforces the Anthropic minimum of 1024), got ${JSON.stringify(thinkingBudget)}`
    );
  }
  if (
    reasoningEffort !== undefined &&
    reasoningEffort !== 'low' &&
    reasoningEffort !== 'medium' &&
    reasoningEffort !== 'high'
  ) {
    throw new Error(
      `[gauntlet/runs/run.js] reasoningEffort: must be "low", "medium" or "high", got ${JSON.stringify(reasoningEffort)}`
    );
  }

  const gameMap = normalizeGames(games, suite);
  const jobs = planJobs(suite);
  const manifestHash = manifestSha256(suite);

  await mkdir(outDir, { recursive: true });
  const startedAtMs = now();

  // The bundle carries the manifest so verifyBundle can recompute its hash
  // without asking the caller for anything but the game implementations.
  const suiteJsonPath = path.join(outDir, 'suite.json');
  if (resume) {
    const existing = await readJsonFile(suiteJsonPath);
    if (existing.ok && canonicalSha256(existing.value) !== manifestHash) {
      throw new Error(
        `[gauntlet/runs/run.js] resume: outDir holds a run of a different suite manifest (suite.json hash ${canonicalSha256(existing.value)}, incoming ${manifestHash}); refusing to mix manifests in one bundle`
      );
    }
  }
  await atomicWriteFile(suiteJsonPath, JSON.stringify(suite, null, 2) + '\n');

  // Prices provenance: the bytes of the file, or the canonical JSON of the
  // object. The hash is recorded; the prices themselves are not copied.
  /** @type {RunRecord['prices']} */
  const pricesRecord = { sha256: null };
  if (pricesPath !== undefined) {
    const bytes = await readFile(pricesPath, 'utf8');
    JSON.parse(bytes); // refuse to bless a prices file that does not parse
    pricesRecord.sha256 = sha256Hex(bytes);
    pricesRecord.path = pricesPath;
  } else if (prices !== undefined) {
    pricesRecord.sha256 = sha256Hex(JSON.stringify(prices));
  }

  //
  // Resume: classify every planned job. Verified files are skipped;
  // missing or unverifiable ones are re-run.
  //
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const replayed = [];
  /** @type {Job[]} */
  const toRun = [];
  for (const job of jobs) {
    if (!resume) {
      toRun.push(job);
      continue;
    }
    const parsed = await readJsonFile(trajectoryPath(outDir, job));
    if (!parsed.ok) {
      if (!parsed.missing) replayed.push(job.key); // corrupt JSON: re-run it
      toRun.push(job);
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
      replayed.push(job.key);
      toRun.push(job);
      continue;
    }
    const verdict = await verifyTrajectory(/** @type {Game<*>} */ (gameMap.get(job.gameId)), t);
    if (verdict.ok) {
      skipped.push(job.key);
    } else {
      replayed.push(job.key);
      toRun.push(job);
    }
  }

  //
  // Shared run state, mutated from the worker pool. JS is single-threaded, so
  // counter updates between awaits are safe. `reservedUsd` holds the summed
  // worst-case quotes of the calls in flight: admission adds the new call's
  // quote and settlement removes it, so settled spend plus reservations can
  // never exceed a cap that admitted them. Quote-less agents keep the
  // settled-only overshoot documented in the header.
  //
  const stopped = /** @type {{ reason: StopReason | null, detail: string | null }} */ ({
    reason: null,
    detail: null,
  });
  let spendUsd = 0;
  let unknownCostSteps = 0;
  let reservedUsd = 0;
  let calls = 0;
  let fatalError = /** @type {UnknownCostError | null} */ (null);
  const limiter =
    requestsPerMinute === undefined ? null : createRateLimiter({ requestsPerMinute, now, sleep });

  /**
   * Wrap one episode's agent with the run's stop rules.
   *
   * @param {Agent} base
   * @param {Job} job
   * @returns {Agent}
   */
  function wrapAgent(base, job) {
    return {
      ...base,
      async act(/** @type {TurnContext} */ ctx) {
        if (stopped.reason) {
          throw new RunAbortedError(stopped.reason, `run stopped (${stopped.reason}): ${stopped.detail ?? ''}`);
        }
        if (signal?.aborted) {
          stopped.reason = stopped.reason ?? 'cancelled';
          stopped.detail = stopped.detail ?? `${job.key}: aborted by signal`;
          throw new RunAbortedError('cancelled', `run aborted by signal at ${job.key}`);
        }
        if (maxCalls !== undefined && calls >= maxCalls) {
          stopped.reason = stopped.reason ?? 'calls';
          stopped.detail = stopped.detail ?? `${job.key}: maxCalls ${maxCalls} reached`;
          throw new RunAbortedError('calls', `maxCalls ${maxCalls} reached at ${job.key}`);
        }
        // Worst-case admission for the dollar cap: a quote-carrying agent
        // reserves its next call's upper-bound cost, so concurrent in-flight
        // calls cannot jointly push spend past `maxUsd`. A quote-less agent
        // keeps the settled-only check (its quote is null).
        const quote =
          maxUsd !== undefined && typeof base.quoteWorstCaseUsd === 'function'
            ? base.quoteWorstCaseUsd(ctx)
            : null;
        if (maxUsd !== undefined) {
          const projected = spendUsd + reservedUsd + (quote ?? 0);
          const overBudget = projected > maxUsd || spendUsd >= maxUsd;
          if (overBudget) {
            stopped.reason = stopped.reason ?? 'budget';
            stopped.detail =
              stopped.detail ??
              `${job.key}: maxUsd ${maxUsd} reached (settled ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`;
            throw new RunAbortedError(
              'budget',
              `maxUsd ${maxUsd} would be exceeded at ${job.key} (settled ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`
            );
          }
        }
        if (limiter) await limiter.acquire();
        calls += 1;
        if (quote !== null) reservedUsd += quote;
        try {
          const reply = await base.act(ctx);
          const cost = reply?.usage?.costUsd;
          if (maxUsd !== undefined && !(typeof cost === 'number' && Number.isFinite(cost))) {
            const message =
              `[gauntlet/runs/run.js] budget: episode ${job.key} step returned costUsd ` +
              `${JSON.stringify(cost === undefined ? null : cost)} with maxUsd ${maxUsd} set; the cap cannot be ` +
              `enforced without a price entry for ${base.id ?? 'this agent'} — add the provider/model to the ` +
              'prices file, or run without maxUsd';
            stopped.reason = 'error';
            stopped.detail = message;
            throw new UnknownCostError(message);
          }
          // Only a finite, defined cost counts toward spend. With a cap set
          // the null-cost refusal above already fired; without a cap an
          // unpriced call (costUsd null or undefined) is treated as free in
          // the sum rather than poisoning it into NaN. A call that DID report
          // usage but without a cost is not free — it is unknown — so it is
          // counted separately and the summary says unknown instead of
          // printing a known-cost sum as if it were the whole spend.
          if (typeof cost === 'number' && Number.isFinite(cost)) {
            spendUsd += cost;
          } else if (reply && reply.usage) {
            unknownCostSteps += 1;
          }
          return reply;
        } finally {
          // Settle the reservation: the call's actual cost has been added to
          // spendUsd (or the call failed), so the worst-case hold is released.
          if (quote !== null) reservedUsd = Math.max(0, reservedUsd - quote);
        }
      },
    };
  }

  //
  // Worker pool.
  //
  /** @type {Trajectory[]} */
  const trajectories = [];
  /** @type {{ key: string, error: string }[]} */
  const failures = [];
  /** @type {Set<string>} */
  const written = new Set();
  let next = 0;

  async function worker() {
    for (;;) {
      if (stopped.reason) return;
      const i = next;
      next += 1;
      if (i >= toRun.length) return;
      const job = toRun[i];
      try {
        const base = await agentFactory(job);
        if (!base || typeof base.act !== 'function') {
          throw new Error(`agentFactory returned no Agent for ${job.key}`);
        }
        const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
        const trajectory = await runEpisode({
          game,
          tierId: job.tierId,
          seed: job.seed,
          split: job.split,
          agent: wrapAgent(base, job),
          now,
        });
        await atomicWriteFile(trajectoryPath(outDir, job), JSON.stringify(trajectory, null, 2) + '\n');
        written.add(job.key);
        trajectories.push(trajectory);
      } catch (err) {
        if (err instanceof UnknownCostError) {
          stopped.reason = 'error';
          stopped.detail = err.message;
          fatalError = err;
          return;
        }
        if (err instanceof RunAbortedError) {
          stopped.reason = stopped.reason ?? err.reason;
          stopped.detail = stopped.detail ?? `${job.key}: ${err.message}`;
          return;
        }
        // Agent or game error on one episode: record it and keep going; the
        // episode is unplayed, so a later resume retries it.
        failures.push({ key: job.key, error: errorMessage(err) });
      }
    }
  }

  const workerCount = Math.min(concurrency, toRun.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  //
  // Provenance.
  //
  /** @type {RunAgentRecord | null} */
  let agentRecord = null;
  try {
    const probe = await agentFactory(jobs[0]);
    if (probe && typeof probe.id === 'string') {
      agentRecord = {
        id: probe.id,
        track: String(probe.track),
        ...(probe.provider !== undefined ? { provider: probe.provider } : {}),
        ...(probe.model !== undefined ? { model: probe.model } : {}),
      };
    }
  } catch {
    agentRecord = null; // the run itself reports factory failures per job
  }

  const skippedSet = new Set(skipped);
  const unplayed = jobs.filter((j) => !skippedSet.has(j.key) && !written.has(j.key)).map((j) => j.key);

  /** @type {RunRecord} */
  const run = {
    format: RUN_FORMAT,
    suite: { id: suite.id, split: suite.split, manifestSha256: manifestHash },
    git: { commit: gitCommit() },
    node: process.version,
    agent: agentRecord,
    prices: pricesRecord,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    concurrency,
    limits: {
      maxUsd: maxUsd ?? null,
      maxCalls: maxCalls ?? null,
      requestsPerMinute: requestsPerMinute ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      callTimeoutMs: callTimeoutMs ?? null,
      thinkingBudget: thinkingBudget ?? null,
      reasoningEffort: reasoningEffort ?? null,
    },
    spendUsd,
    unknownCostSteps,
    calls,
    counts: {
      jobs: jobs.length,
      played: written.size,
      skipped: skipped.length,
      replayed: replayed.length,
      unplayed: unplayed.length,
      failed: failures.length,
    },
    skipped,
    replayed,
    unplayed,
    failed: failures,
    stopped: stopped.reason,
    stopReason: stopped.detail,
  };
  await atomicWriteFile(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');

  if (fatalError) throw fatalError;

  return {
    run,
    trajectories,
    skipped,
    replayed,
    unplayed,
    failed: failures,
    stopped: stopped.reason,
    stopReason: stopped.detail,
    spendUsd,
    unknownCostSteps,
    calls,
  };
}
