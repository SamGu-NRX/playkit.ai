/**
 * `gauntlet page`: attach any Gauntlet agent — the same agent specs
 * `gauntlet run` takes — to the vendored 2048 page through the overlay's own
 * injection path, write the refereed session log into a run bundle, and exit
 * non-zero when the referee flags a move (the log then fails replay
 * verification at exactly that move).
 *
 *   gauntlet page --agent <spec> --out <dir> [--base-url <url>]
 *                 [--api-key-env <var>] [--moves <n>] [--seed <s>]
 *                 [--timeout-ms <ms>] [--url-path <path>]
 *
 * Writes `page/<seed>.json` (the `playkit-gauntlet-bridge-log/1` session log)
 * and `page/run.json` (provenance plus the agent's turn accounting — latency,
 * retries, token totals; unreported counts stay `unknown`, never 0) into the
 * bundle directory. `gauntlet bundle verify` replays every `page/*.json` with
 * `verifyBridgeLog`, standalone or alongside a `gauntlet run` bundle.
 *
 * The browser lives in the nested package `gauntlet/bridge/browser` (its own
 * `package.json` with Playwright), so this module loads it with a dynamic
 * import — computed, not a literal specifier, so typechecking of the main
 * package never resolves into the optional nested package either. Any other
 * subcommand never touches this file's browser path.
 *
 * Node-only. The specifier string above must stay resolvable from this file's
 * location.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAgentSpec } from './agents.js';
import { getGame } from '../games/index.js';
import { verifyBridgeLog } from '../bridge/session-log.js';

/** Path of the nested browser package's page-session module, resolved from
 * this file: gauntlet/cli → ../bridge/browser/page-session.mjs. */
const PAGE_SESSION_URL = new URL('../bridge/browser/page-session.mjs', import.meta.url).href;

/**
 * @typedef {object} PageCommandOptions
 * @property {string} agentSpecText --agent: the same specs `gauntlet run`
 *   takes (random | baseline:<game>:<greedy|engine> | model:<provider>/<model>).
 * @property {string} outDir --out: the bundle directory to write into
 *   (created when missing; a `gauntlet run` bundle gains page sessions
 *   alongside its trajectories).
 * @property {number} [maxMoves] --moves: session move cap (default 150).
 * @property {number} [seed] --seed: pins the page's Math.random so the
 *   session is reproducible; without it the page's own randomness plays and
 *   the log file is named by timestamp.
 * @property {number} [timeoutMs] --timeout-ms: whole-session timeout
 *   (default 600000). A stalled model endpoint rejects within it instead of
 *   hanging forever.
 * @property {string} [urlPath] --url-path: page to open relative to the
 *   fixture server root (default `/2048/`; `/2048-faulty/` is the tampered
 *   copy used to prove the referee path).
 * @property {string} [baseUrl] --base-url: API root for openai-chat model
 *   specs (required by that provider, as in `gauntlet run`).
 * @property {string} [apiKeyEnv] --api-key-env: env var holding the API key.
 * @property {string} [prices] --prices: price file for cost accounting.
 * @property {string} [script] --script: reply script for --dry-run specs.
 * @property {boolean} [dryRun] --dry-run: rehearse a model spec offline.
 * @property {number} [maxOutputTokens] --max-output-tokens: per-reply output
 *   cap for live model specs.
 * @property {number} [callTimeoutMs] --call-timeout-ms: per-attempt timeout
 *   for live model specs (a timed-out attempt retries like a transport error).
 */

/**
 * Run one page session and write the bundle files.
 *
 * @param {PageCommandOptions} options
 * @returns {Promise<{ verified: { ok: true } | { ok: false, index: number, reason: string }, logPath: string, runPath: string, summary: Record<string, *> }>}
 */
export async function runPageSubcommand(options) {
  const { agentSpecText, outDir } = options;
  if (typeof agentSpecText !== 'string' || agentSpecText.length === 0) {
    throw new Error('gauntlet page: --agent <spec> is required');
  }
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new Error('gauntlet page: --out <dir> is required');
  }
  const maxMoves = options.maxMoves ?? 150;
  const timeoutMs = options.timeoutMs ?? 600000;
  const urlPath = options.urlPath ?? '/2048/';
  const seed = options.seed;

  // The same spec resolution as `gauntlet run` — including the openai-chat
  // --base-url requirement and the --dry-run/--script pairing rules.
  const spec = await parseAgentSpec(agentSpecText, {
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKeyEnv !== undefined ? { apiKeyEnv: options.apiKeyEnv } : {}),
    ...(options.prices !== undefined ? { prices: options.prices } : {}),
    ...(options.script !== undefined ? { script: options.script } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
  });

  // The page path plays the vendored 2048 page, so a baseline scoped to
  // another game is a caller error, not a silent mismatch.
  const game = getGame('2048');
  if (spec.gameId !== null && spec.gameId !== game.spec.id) {
    throw new Error(
      `gauntlet page plays the vendored 2048 page only; agent spec "${agentSpecText}" plays game "${spec.gameId}"`,
    );
  }

  /** Which agent rides the page: an in-page baseline, or a Node-side agent. */
  const baselineMatch = /^baseline:2048:(greedy|engine)$/.exec(agentSpecText);
  const agent = baselineMatch
    ? { mode: /** @type {'in-page'} */ ('in-page'), name: /** @type {'greedy' | 'engine'} */ (baselineMatch[1]) }
    : {
        mode: /** @type {'node'} */ ('node'),
        agent: await spec.createForEpisode({
          game,
          tier: game.spec.tiers[0],
          seed: seed !== undefined ? String(seed) : `page-${new Date().toISOString()}`,
          agentSeat: 0,
        }),
      };

  // Load the nested browser package now — and only now, so every other
  // subcommand runs without Playwright installed. A computed specifier keeps
  // the main package's typecheck from resolving into the optional package.
  /** @type {*} */
  let pageSession;
  try {
    pageSession = await import(PAGE_SESSION_URL);
  } catch (err) {
    throw new Error(
      `gauntlet page could not load the browser bridge package (gauntlet/bridge/browser): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { ensureBookmarkletBundle, startFixtureServer } = await import(
    new URL('../bridge/browser/harness.mjs', import.meta.url).href
  );
  const { runPageSession, launchChromium, pageLogName } = pageSession;

  // Build the overlay bundle and serve page + overlay + gauntlet from one
  // 127.0.0.1 server, exactly as the browser suite does; everything here is
  // local, no network beyond 127.0.0.1.
  await ensureBookmarkletBundle();
  const server = await startFixtureServer();
  /** @type {*} */
  let report;
  let browser;
  try {
    browser = await launchChromium();
    report = await runPageSession({ browser, port: server.port, agent, maxMoves, urlPath, seed, timeoutMs });
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  // The referee's verdict, re-derived: the replay is the audit, so a
  // referee-flagged divergence fails here at the offending move.
  const verified = verifyBridgeLog(report.log);

  // Write the bundle: page/<seed>.json is the session log; page/run.json is
  // provenance plus the turn accounting.
  const stem = pageLogName(seed);
  const pageDir = path.join(outDir, 'page');
  await mkdir(pageDir, { recursive: true });
  const logPath = path.join(pageDir, `${stem}.json`);
  await writeFile(logPath, JSON.stringify(report.log, null, 2) + '\n');
  const runPath = path.join(pageDir, 'run.json');
  await writeFile(
    runPath,
    JSON.stringify(
      {
        format: 'playkit-gauntlet-page-run/1',
        agent: { spec: agentSpecText, id: report.log.agent.id, track: report.log.agent.track },
        seed: seed ?? null,
        urlPath,
        moves: report.moves,
        endedWhy: report.endedWhy,
        diverged: report.diverged,
        fallbacks: report.fallbacks,
        logFile: `page/${stem}.json`,
        verify: verified.ok ? { ok: true } : { ok: false, step: verified.index, reason: verified.reason },
        accounting: report.accounting,
        turns: report.turns,
        startedAt: report.log.startedAt,
        finishedAt: report.log.finishedAt,
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const summary = {
    agent: report.log.agent.id,
    spec: agentSpecText,
    seed: seed ?? null,
    moves: report.moves,
    endedWhy: report.endedWhy,
    diverged: report.diverged,
    fallbacks: report.fallbacks,
    errorTurns: report.accounting.errorTurns,
    finalScore: report.finalScore,
    verify: verified.ok ? 'ok' : `FAILED at step ${verified.index}: ${verified.reason}`,
  };

  process.stdout.write(
    [
      `game     2048 (vendored live page${urlPath === '/2048/' ? '' : `, ${urlPath}`})`,
      `seed     ${seed ?? 'unpinned (page randomness)'}${seed !== undefined ? ' — page Math.random pin' : ''}`,
      `agent    ${report.log.agent.id} (track ${report.log.agent.track}) — spec ${agentSpecText}`,
      `end      ${report.endedWhy} after ${report.moves} refereed moves (${report.diverged} diverged, ${report.fallbacks} fallbacks)`,
      `turns    ${report.turns.length} agent calls through Node (${report.accounting.errorTurns} failed)`,
      verified.ok
        ? 'replay   ok — every recorded transition re-derives from the rules'
        : `replay   FAILED at step ${verified.index} — ${verified.reason}`,
      `saved    page/${stem}.json (+ page/run.json) in ${outDir}`,
      '',
    ].join('\n'),
  );

  return { verified, logPath, runPath, summary };
}

export {};
