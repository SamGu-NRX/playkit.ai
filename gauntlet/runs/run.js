/**
 * The run engine: plays a whole suite with bounded concurrency, a shared
 * token-bucket rate limit, a hard dollar cap and a hard call cap, an optional
 * per-episode wall-clock limit, atomic
 * per-episode trajectory files, resume without replaying finished episodes,
 * and a `run.json` provenance record that makes the results bundle verifiable
 * by anyone with the games and the manifest. The record's per-invocation fields
 * describe the invocation that wrote it; its `total` block sums every
 * trajectory in the run directory, so after a `--resume` the bundle still
 * describes the whole run.
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
 * Bundle-wide spend: `maxUsdTotal` bounds the whole results bundle across
 * resumes, where `maxUsd` bounds one invocation. The bundle carries
 * `spend.jsonl`, an append-only ledger with one line per run invocation, per
 * recorded cap, and per paid call — kept (its episode produced a trajectory)
 * or unwound (a stop threw the episode away; the spend stays recorded). A
 * rejected call is charged at its reserved worst-case quote: the provider may
 * bill a call the client abandoned, and the client cannot see the amount. The
 * ledger is hash-chained (each line names the SHA-256 of the previous line's
 * exact text), so editing or dropping a line is detectable; resuming records
 * the invocation and carries the recorded cap unless a new `maxUsdTotal` is
 * passed, which is itself recorded. A bundle whose ledger holds unpriced
 * calls refuses a total cap: unknown spend cannot be bounded. Graceful stops
 * (budget, calls, signal, error) flush every buffered line; a hard kill
 * mid-episode can lose that episode's buffered lines.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
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
 * The bundle's spend ledger, written next to run.json. Append-only JSON
 * Lines; each line's `prev` names the SHA-256 of the previous line's exact
 * text (null on the first line), so any edit or drop of a line is visible.
 */
export const SPEND_LEDGER_FILENAME = 'spend.jsonl';

/**
 * @typedef {object} SpendLedgerSummary
 * @property {number} invocations Run invocations recorded.
 * @property {number} calls Paid agent calls recorded (kept and unwound).
 * @property {number | null} cap The recorded bundle-wide cap, when one was set.
 * @property {number} totalUsd Summed known cost over every recorded call.
 * @property {number} keptUsd Spend inside episodes that produced a trajectory.
 * @property {number} unwoundUsd Spend a stop threw away (replayed on resume).
 * @property {number} unwoundCalls Calls belonging to unwound episodes.
 * @property {number} unknownCalls Calls recorded without a usable cost.
 */

/**
 * Parse and validate the ledger's text: per-line kind shape plus the hash
 * chain. Well-formed lines return their parsed value even when later lines
 * are broken; the chain cannot be verified past a line that does not parse.
 *
 * @param {string} text
 * @returns {{ lines: { text: string, value: any }[], problems: string[], summary: SpendLedgerSummary }}
 */
export function parseSpendLedger(text) {
  /** @type {{ text: string, value: any }[]} */
  const lines = [];
  /** @type {string[]} */
  const problems = [];
  const rawLines = String(text).split('\n').filter((l) => l.trim().length > 0);
  let prevHash = null;
  let invocations = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push(`line ${i}: not JSON`);
      lines.push({ text: raw, value: null });
      prevHash = sha256Hex(raw);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`line ${i}: not a JSON object`);
      lines.push({ text: raw, value: null });
      prevHash = sha256Hex(raw);
      continue;
    }
    if (value.prev !== prevHash) {
      const got = value.prev === null || value.prev === undefined ? 'null' : `${String(value.prev).slice(0, 12)}…`;
      const expected = prevHash === null ? 'null' : `${prevHash.slice(0, 12)}…`;
      problems.push(`line ${i}: prev hash mismatch (expected ${expected}, got ${got})`);
    }
    switch (value.kind) {
      case 'invocation': {
        if (value.invocation !== invocations) {
          problems.push(`line ${i}: invocation index ${JSON.stringify(value.invocation)}, expected ${invocations}`);
        }
        if (typeof value.startedAt !== 'string' || value.startedAt.length === 0) {
          problems.push(`line ${i}: invocation without a startedAt`);
        }
        invocations += 1;
        break;
      }
      case 'cap': {
        if (!Number.isInteger(value.invocation) || value.invocation < 0 || value.invocation >= Math.max(invocations, 1)) {
          problems.push(`line ${i}: cap names invocation ${JSON.stringify(value.invocation)} which has not started`);
        }
        if (typeof value.maxUsdTotal !== 'number' || !Number.isFinite(value.maxUsdTotal) || value.maxUsdTotal <= 0) {
          problems.push(`line ${i}: cap maxUsdTotal must be a positive finite number, got ${JSON.stringify(value.maxUsdTotal)}`);
        }
        break;
      }
      case 'call': {
        if (!Number.isInteger(value.invocation) || value.invocation < 0 || value.invocation >= Math.max(invocations, 1)) {
          problems.push(`line ${i}: call names invocation ${JSON.stringify(value.invocation)} which has not started`);
        }
        if (typeof value.job !== 'string' || value.job.length === 0) {
          problems.push(`line ${i}: call without a job key`);
        }
        if (!Number.isInteger(value.call) || value.call < 0) {
          problems.push(`line ${i}: call index must be a non-negative integer, got ${JSON.stringify(value.call)}`);
        }
        if (value.costUsd !== null && (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd))) {
          problems.push(`line ${i}: call costUsd must be a finite number or null, got ${JSON.stringify(value.costUsd)}`);
        }
        if (typeof value.kept !== 'boolean') {
          problems.push(`line ${i}: call kept must be a boolean`);
        }
        if (typeof value.chargedAtReservation !== 'boolean') {
          problems.push(`line ${i}: call chargedAtReservation must be a boolean`);
        }
        break;
      }
      default:
        problems.push(`line ${i}: unknown kind ${JSON.stringify(value.kind)}`);
    }
    lines.push({ text: raw, value });
    prevHash = sha256Hex(raw);
  }
  return { lines, problems, summary: summarizeSpendLedgerLines(lines, invocations) };
}

/**
 * @param {{ text: string, value: any }[]} lines
 * @param {number} invocations
 * @returns {SpendLedgerSummary}
 */
function summarizeSpendLedgerLines(lines, invocations) {
  let calls = 0;
  let totalUsd = 0;
  let keptUsd = 0;
  let unwoundUsd = 0;
  let unwoundCalls = 0;
  let unknownCalls = 0;
  let cap = /** @type {number | null} */ (null);
  for (const { value } of lines) {
    if (!value) continue;
    if (value.kind === 'cap' && typeof value.maxUsdTotal === 'number' && Number.isFinite(value.maxUsdTotal)) {
      cap = value.maxUsdTotal;
    }
    if (value.kind !== 'call') continue;
    calls += 1;
    const cost = value.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      totalUsd += cost;
      if (value.kept === true) keptUsd += cost;
      else {
        unwoundUsd += cost;
        unwoundCalls += 1;
      }
    } else {
      unknownCalls += 1;
    }
  }
  return { invocations, calls, cap, totalUsd, keptUsd, unwoundUsd, unwoundCalls, unknownCalls };
}

/**
 * Read and validate the bundle's spend ledger. A missing file reports
 * `{ present: false }` (bundles from before the ledger stay verifiable); an
 * unreadable or malformed one reports the problems and lets the caller refuse.
 *
 * @param {string} outDir
 * @returns {Promise<{ present: boolean, lines: { text: string, value: any }[], problems: string[], summary: SpendLedgerSummary }>}
 */
export async function readSpendLedger(outDir) {
  const ledgerPath = path.join(outDir, SPEND_LEDGER_FILENAME);
  let text;
  try {
    text = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    if (/** @type {*} */ (err)?.code === 'ENOENT') {
      return { present: false, lines: [], problems: [], summary: summarizeSpendLedgerLines([], 0) };
    }
    return {
      present: true,
      lines: [],
      problems: [`could not read ${SPEND_LEDGER_FILENAME}: ${errorMessage(err)}`],
      summary: summarizeSpendLedgerLines([], 0),
    };
  }
  const parsed = parseSpendLedger(text);
  return { present: true, lines: parsed.lines, problems: parsed.problems, summary: parsed.summary };
}

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
 * Display label for one episode job. A job key is `<game>/<tier>/<seed>` and
 * the seed itself is `<game>/<tier>/<split>/<i>`, so the raw key repeats the
 * game and tier prefix (`chess/wood/chess/wood/public/0`); stop details and
 * error messages are for people, so they show the seed alone. Machine-read
 * key fields in the record (skipped, replayed, unplayed, failed) keep the
 * full stable key.
 *
 * @param {Job} job
 * @returns {string}
 */
function jobLabel(job) {
  return job.seed.startsWith(`${job.gameId}/${job.tierId}/`) ? job.seed : job.key;
}

/**
 * Whole-bundle totals: walk the run directory, sum every trajectory that
 * parses, and fold each step's usage — the same whole-bundle basis as the
 * estimate-vs-actual comparison, so `run.json`'s `total` block and the
 * `--against` comparison agree by construction. Steps without a parsed
 * `usage` object contribute nothing on any side (engine moves are not model
 * calls); steps with usage but no finite costUsd are counted in
 * `unknownCostSteps` rather than silently averaged into zero.
 *
 * @param {string} outDir
 * @returns {Promise<RunTotals>}
 */
export async function sumRunDirectory(outDir) {
  /** @type {RunTotals} */
  const totals = {
    episodes: 0,
    calls: 0,
    tokens: { input: 0, output: 0 },
    spendUsd: 0,
    unknownCostSteps: 0,
  };
  const stack = [outDir];
  for (;;) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      // Top-level records (run.json, suite.json, prices.json) do not parse
      // as trajectories, so the format check below skips them.
      const parsed = await readJsonFile(filePath);
      const t = /** @type {any} */ (parsed.ok ? parsed.value : null);
      if (!t || t.format !== TRAJECTORY_FORMAT || !Array.isArray(t.steps)) continue;
      totals.episodes += 1;
      for (const step of t.steps) {
        const usage = step?.usage;
        if (!usage) continue;
        totals.calls += 1;
        if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
          totals.tokens.input += usage.inputTokens;
        }
        if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
          totals.tokens.output += usage.outputTokens;
        }
        if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
          totals.spendUsd += usage.costUsd;
        } else {
          totals.unknownCostSteps += 1;
        }
      }
    }
  }
  return totals;
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
 * @property {string} [thinking] The agent's thinking mode (model agents on
 *   provider "anthropic": "adaptive", "enabled", "off" or
 *   "provider-default"), so a run says whether thinking was on.
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
 * Whole-bundle totals behind run.json's `total` block: what the results
 * bundle holds, as opposed to what one invocation played.
 *
 * @typedef {object} RunTotals
 * @property {number} episodes Trajectory files in the run directory that parse as trajectories.
 * @property {number} calls Agent calls recorded across those episodes (the steps that reported usage).
 * @property {{ input: number, output: number }} tokens Summed reported input/output tokens. A step whose provider reported no token count adds 0 on that side; its unpriced cost shows in unknownCostSteps.
 * @property {number} spendUsd Summed finite step costs. A step that reported usage without a finite costUsd counts here as 0 and separately in unknownCostSteps — unknown stays unknown, it is never folded into 0 (same semantics as the per-invocation spendUsd).
 * @property {number} unknownCostSteps Steps that reported usage with a null (or non-finite) costUsd.
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
 * @property {{ maxUsd: number | null, maxUsdTotal: number | null, maxCalls: number | null, requestsPerMinute: number | null, maxOutputTokens: number | null, callTimeoutMs: number | null, thinkingBudget: number | null, reasoningEffort: string | null, episodeTimeLimitMs: number | null }} limits
 * @property {number} spendUsd Sum of the steps' known costs. A step that
 *   reported usage without a priced cost counts here as 0 and separately in
 *   unknownCostSteps — unknown stays unknown, it is never folded into 0.
 * @property {number} unknownCostSteps Steps whose reply carried usage with a
 *   null (or non-finite) costUsd: usage was reported, so the cost is unknown,
 *   not zero.
 * @property {number} calls
 * @property {RunTotals} total Whole-bundle totals summed from every trajectory
 *   in the run directory and recomputed on each invocation; after a
 *   `--resume` it covers episodes played and verified by earlier invocations
 *   too, where the per-invocation fields above describe only the invocation
 *   that wrote this record.
 * @property {{ file: string, invocations: number, calls: number, cap: number | null, totalUsd: number, keptUsd: number, unwoundUsd: number, unwoundCalls: number, unknownCalls: number, problems: string[] }} ledger
 *   The bundle's spend-ledger state after this invocation: the re-read
 *   summary of `spend.jsonl` (which now includes this invocation's lines)
 *   with the effective cap (a new `maxUsdTotal`, else the recorded one) and
 *   any problems met while appending. Call lines buffer per episode and
 *   flush at its end, so a graceful stop loses nothing; a hard kill
 *   mid-episode can lose that episode's buffered lines.
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
 * @property {number} [maxUsdTotal] Hard dollar cap on the whole results
 *   bundle across resumes, recorded in the bundle's spend ledger
 *   (`spend.jsonl`). On resume the recorded cap is carried unless a new
 *   value is passed; the raise (or a rewrite of the same value) is recorded
 *   too. Requires a prices file, because the cap must price every call it
 *   bounds.
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
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [reasoningEffort] Recorded in
 *   run.json's limits for provenance; the OpenAI reasoning effort itself is
 *   applied by the agent layer (reasoning.effort / reasoning_effort).
 * @property {number} [episodeTimeLimitMs] Wall-clock cap on each episode, in
 *   milliseconds. Enforced here by passing it to every `runEpisode` call (the
 *   runner ends a stalled episode with a `time-limit` trajectory) and
 *   recorded in run.json's limits for provenance.
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
 * @property {RunRecord['ledger']} ledger The bundle's spend-ledger state after this invocation.
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
  maxUsdTotal,
  maxCalls,
  requestsPerMinute,
  maxOutputTokens,
  callTimeoutMs,
  thinkingBudget,
  reasoningEffort,
  episodeTimeLimitMs,
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
  if (maxUsdTotal !== undefined && (typeof maxUsdTotal !== 'number' || !Number.isFinite(maxUsdTotal) || maxUsdTotal <= 0)) {
    throw new Error(
      `[gauntlet/runs/run.js] maxUsdTotal: must be a positive finite number, got ${JSON.stringify(maxUsdTotal)}`
    );
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
  if (
    episodeTimeLimitMs !== undefined &&
    (!Number.isInteger(episodeTimeLimitMs) || episodeTimeLimitMs < 1)
  ) {
    throw new Error(
      `[gauntlet/runs/run.js] episodeTimeLimitMs: must be a positive integer (milliseconds), got ${JSON.stringify(episodeTimeLimitMs)}`
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
    reasoningEffort !== 'high' &&
    reasoningEffort !== 'xhigh' &&
    reasoningEffort !== 'max'
  ) {
    throw new Error(
      `[gauntlet/runs/run.js] reasoningEffort: must be "low", "medium", "high", "xhigh" or "max", got ${JSON.stringify(reasoningEffort)}`
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
  // The bundle's spend ledger. Every invocation appends one `invocation`
  // line; a run with `maxUsdTotal` appends a `cap` line when the value is new
  // (on a fresh bundle, or when resuming with a raised or rewritten cap); a
  // resumed run without `maxUsdTotal` carries the recorded cap. Call lines
  // buffer per episode and flush in the worker's finally block, so a graceful
  // stop records every paid call — including the spend of episodes a stop
  // threw away.
  //
  const ledgerPath = path.join(outDir, SPEND_LEDGER_FILENAME);
  const ledgerAtStart = await readSpendLedger(outDir);
  if (ledgerAtStart.problems.length > 0) {
    throw new Error(
      `[gauntlet/runs/run.js] refusing to run on top of a malformed spend.jsonl: ${ledgerAtStart.problems[0]}` +
        (ledgerAtStart.problems.length > 1 ? ` (and ${ledgerAtStart.problems.length - 1} more problem(s))` : '')
    );
  }
  if (maxUsdTotal !== undefined && ledgerAtStart.summary.unknownCalls > 0) {
    throw new Error(
      `[gauntlet/runs/run.js] maxUsdTotal: spend.jsonl records ${ledgerAtStart.summary.unknownCalls} call(s) with unknown spend; a total cap cannot be enforced over unknown spend — rerun without maxUsdTotal, or start a fresh bundle`
    );
  }
  const invocationIndex = ledgerAtStart.summary.invocations;
  const maxUsdTotalEffective = /** @type {number | null} */ (maxUsdTotal ?? ledgerAtStart.summary.cap);
  let ledgerChainHead =
    ledgerAtStart.lines.length > 0 ? sha256Hex(ledgerAtStart.lines[ledgerAtStart.lines.length - 1].text) : null;
  /** @type {string[]} */
  const ledgerProblems = [];

  /**
   * Appends lines to the ledger, extending the hash chain. On failure the
   * problem is recorded (run.json's ledger.problems) and the run continues:
   * losing provenance must not corrupt a paid run mid-flight.
   *
   * @param {Record<string, unknown>[]} values
   * @returns {Promise<void>}
   */
  async function appendSpendLines(values) {
    if (values.length === 0) return;
    let text = '';
    for (const value of values) {
      const line = JSON.stringify({ ...value, prev: ledgerChainHead });
      ledgerChainHead = sha256Hex(line);
      text += line + '\n';
    }
    try {
      await appendFile(ledgerPath, text, 'utf8');
    } catch (err) {
      ledgerProblems.push(`could not append ${values.length} ledger line(s): ${errorMessage(err)}`);
    }
  }

  await appendSpendLines([
    { kind: 'invocation', invocation: invocationIndex, startedAt: new Date(startedAtMs).toISOString(), resumed: resume },
  ]);
  if (maxUsdTotal !== undefined && (ledgerAtStart.summary.cap === null || ledgerAtStart.summary.cap !== maxUsdTotal)) {
    await appendSpendLines([{ kind: 'cap', invocation: invocationIndex, maxUsdTotal }]);
  }
  // Spend already on the books from earlier invocations. The per-invocation
  // admission checks below add this invocation's settled and reserved spend.
  const ledgerUsd = ledgerAtStart.summary.totalUsd;
  const spendCapped = maxUsd !== undefined || maxUsdTotalEffective !== null;

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
  // Buffered ledger call lines per in-flight episode attempt, keyed by job
  // key; the worker's finally block flushes them with the kept flag.
  const episodeRecords = new Map();
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
    // Call records for this episode attempt, buffered and flushed (with their
    // kept flag) when the episode ends — the worker's finally block owns them.
    /** @type {any[]} */
    const records = [];
    episodeRecords.set(job.key, records);
    let episodeCall = 0;
    return {
      ...base,
      async act(/** @type {TurnContext} */ ctx) {
        if (stopped.reason) {
          throw new RunAbortedError(stopped.reason, `run stopped (${stopped.reason}): ${stopped.detail ?? ''}`);
        }
        if (signal?.aborted) {
          stopped.reason = stopped.reason ?? 'cancelled';
          stopped.detail = stopped.detail ?? `${jobLabel(job)}: aborted by signal`;
          throw new RunAbortedError('cancelled', `run aborted by signal at ${jobLabel(job)}`);
        }
        if (maxCalls !== undefined && calls >= maxCalls) {
          stopped.reason = stopped.reason ?? 'calls';
          stopped.detail = stopped.detail ?? `${jobLabel(job)}: maxCalls ${maxCalls} reached`;
          throw new RunAbortedError('calls', `maxCalls ${maxCalls} reached at ${jobLabel(job)}`);
        }
        // Worst-case admission for the dollar caps: a quote-carrying agent
        // reserves its next call's upper-bound cost, so concurrent in-flight
        // calls cannot jointly push spend past a cap. A quote-less agent keeps
        // the settled-only check (its quote is null).
        const quote = typeof base.quoteWorstCaseUsd === 'function' ? base.quoteWorstCaseUsd(ctx) : null;
        if (maxUsd !== undefined) {
          const projected = spendUsd + reservedUsd + (quote ?? 0);
          const overBudget = projected > maxUsd || spendUsd >= maxUsd;
          if (overBudget) {
            stopped.reason = stopped.reason ?? 'budget';
            stopped.detail =
              stopped.detail ??
              `${jobLabel(job)}: maxUsd ${maxUsd} reached (settled ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`;
            throw new RunAbortedError(
              'budget',
              `maxUsd ${maxUsd} would be exceeded at ${jobLabel(job)} (settled ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`
            );
          }
        }
        if (maxUsdTotalEffective !== null) {
          // Cap-stop rule (pinned by runs/cap-unwind.test.js at concurrency 1
          // and 3): this refusal fires BEFORE the call starts, so a call the
          // cap refuses is never charged. Every episode still in flight then
          // unwinds — its attempt ends without a trajectory and the worker's
          // finally block flushes its settled calls with kept:false: paid
          // spend that stays on the books (keptUsd + unwoundUsd = totalUsd)
          // and is replayed on resume as a new attempt. A finished episode's
          // spend is always kept:true — the attempt's flag is the trajectory
          // write's result — and is never counted as unwound. Because every
          // admitted call reserved its worst-case quote at admission,
          // settled + reserved stays <= the cap through the stop, so the
          // ledger total never passes it (it can land exactly on it). The
          // paid-but-discarded amount at one stop is the committed spend of
          // the in-flight episodes, bounded by
          // min(concurrency x per-episode spend, cap); headroom guidance for
          // picking the cap lives in journeys/pilot/PILOT.md.
          const settledTotal = ledgerUsd + spendUsd;
          const projectedTotal = settledTotal + reservedUsd + (quote ?? 0);
          if (projectedTotal > maxUsdTotalEffective || settledTotal >= maxUsdTotalEffective) {
            stopped.reason = stopped.reason ?? 'budget';
            stopped.detail =
              stopped.detail ??
              `${jobLabel(job)}: maxUsdTotal ${maxUsdTotalEffective} reached (ledger ${ledgerUsd}, settled this invocation ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`;
            throw new RunAbortedError(
              'budget',
              `maxUsdTotal ${maxUsdTotalEffective} would be exceeded at ${jobLabel(job)} (ledger ${ledgerUsd}, settled this invocation ${spendUsd}, reserved ${reservedUsd}, next-call worst case ${quote ?? 'unknown'})`
            );
          }
        }
        if (limiter) await limiter.acquire();
        calls += 1;
        const callIndex = episodeCall;
        episodeCall += 1;
        if (quote !== null) reservedUsd += quote;
        try {
          const reply = await base.act(ctx);
          const cost = reply?.usage?.costUsd;
          const priced = typeof cost === 'number' && Number.isFinite(cost);
          if (spendCapped && !priced) {
            const capNames =
              maxUsd !== undefined && maxUsdTotalEffective !== null
                ? 'maxUsd/maxUsdTotal'
                : maxUsdTotalEffective !== null
                  ? 'maxUsdTotal'
                  : 'maxUsd';
            const message =
              `[gauntlet/runs/run.js] budget: episode ${jobLabel(job)} step returned costUsd ` +
              `${JSON.stringify(cost === undefined ? null : cost)} with ${capNames} set; the cap cannot be ` +
              `enforced without a price entry for ${base.id ?? 'this agent'} — add the provider/model to the ` +
              'prices file, or run without the dollar cap' +
              (maxUsd !== undefined ? '' : ' (the recorded maxUsdTotal cannot be dropped: start a new bundle without it)');
            records.push({
              kind: 'call',
              invocation: invocationIndex,
              job: job.key,
              call: callIndex,
              costUsd: null,
              inputTokens: reply?.usage?.inputTokens ?? null,
              outputTokens: reply?.usage?.outputTokens ?? null,
              usage: Boolean(reply && reply.usage),
              kept: false,
              chargedAtReservation: false,
            });
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
          if (priced) {
            spendUsd += cost;
          } else if (reply && reply.usage) {
            unknownCostSteps += 1;
          }
          records.push({
            kind: 'call',
            invocation: invocationIndex,
            job: job.key,
            call: callIndex,
            costUsd: priced ? cost : null,
            inputTokens: reply?.usage?.inputTokens ?? null,
            outputTokens: reply?.usage?.outputTokens ?? null,
            usage: Boolean(reply && reply.usage),
            kept: false,
            chargedAtReservation: false,
          });
          return reply;
        } catch (err) {
          if (err instanceof UnknownCostError) throw err; // recorded above
          // The call rejected: timeout, abort, network error. The provider
          // may bill a call the client abandoned and the client cannot see
          // the amount, so the ledger charges the call at its reserved
          // worst-case quote — the same number admission counted.
          if (quote !== null) spendUsd += quote;
          records.push({
            kind: 'call',
            invocation: invocationIndex,
            job: job.key,
            call: callIndex,
            costUsd: quote,
            inputTokens: null,
            outputTokens: null,
            usage: false,
            kept: false,
            chargedAtReservation: true,
            rejectReason: errorMessage(err),
          });
          throw err;
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
      let keptThisAttempt = false;
      try {
        const base = await agentFactory(job);
        if (!base || typeof base.act !== 'function') {
          throw new Error(`agentFactory returned no Agent for ${jobLabel(job)}`);
        }
        const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
        const trajectory = await runEpisode({
          game,
          tierId: job.tierId,
          seed: job.seed,
          split: job.split,
          agent: wrapAgent(base, job),
          episodeTimeLimitMs,
          now,
        });
        await atomicWriteFile(trajectoryPath(outDir, job), JSON.stringify(trajectory, null, 2) + '\n');
        written.add(job.key);
        trajectories.push(trajectory);
        keptThisAttempt = true;
      } catch (err) {
        if (err instanceof UnknownCostError) {
          stopped.reason = 'error';
          stopped.detail = err.message;
          fatalError = err;
          return;
        }
        if (err instanceof RunAbortedError) {
          stopped.reason = stopped.reason ?? err.reason;
          stopped.detail = stopped.detail ?? `${jobLabel(job)}: ${err.message}`;
          return;
        }
        // Agent or game error on one episode: record it and keep going; the
        // episode is unplayed, so a later resume retries it.
        failures.push({ key: job.key, error: errorMessage(err) });
      } finally {
        // Flush this attempt's buffered call lines. Every attempt records —
        // an episode that was unwound and re-run leaves its earlier attempt's
        // spend on the books with kept:false. Graceful stops flush here; only
        // a hard kill mid-episode can lose buffered lines.
        const records = episodeRecords.get(job.key);
        episodeRecords.delete(job.key);
        if (records !== undefined && records.length > 0) {
          for (const record of records) record.kept = keptThisAttempt;
          await appendSpendLines(/** @type {Record<string, unknown>[]} */ (/** @type {*} */ (records)));
        }
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
        ...(typeof probe.thinking === 'string' ? { thinking: probe.thinking } : {}),
      };
    }
  } catch {
    agentRecord = null; // the run itself reports factory failures per job
  }

  const skippedSet = new Set(skipped);
  const unplayed = jobs.filter((j) => !skippedSet.has(j.key) && !written.has(j.key)).map((j) => j.key);

    // Re-read the ledger for the record: it now includes this invocation's
  // invocation/cap/call lines (appended above and from the workers).
  const ledgerNow = await readSpendLedger(outDir);
  /** @type {RunRecord['ledger']} */
  const ledgerRecord = {
    file: SPEND_LEDGER_FILENAME,
    ...(ledgerNow.present ? ledgerNow.summary : summarizeSpendLedgerLines([], invocationIndex + 1)),
    cap: maxUsdTotalEffective,
    problems: [...ledgerProblems, ...ledgerNow.problems],
  };

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
      maxUsdTotal: maxUsdTotalEffective,
      maxCalls: maxCalls ?? null,
      requestsPerMinute: requestsPerMinute ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
      callTimeoutMs: callTimeoutMs ?? null,
      thinkingBudget: thinkingBudget ?? null,
      reasoningEffort: reasoningEffort ?? null,
      episodeTimeLimitMs: episodeTimeLimitMs ?? null,
    },
    spendUsd,
    unknownCostSteps,
    calls,
    total: await sumRunDirectory(outDir),
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
    ledger: ledgerRecord,
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
    ledger: ledgerRecord,
  };
}
