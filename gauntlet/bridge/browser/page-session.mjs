/**
 * A CLI-facing page session: attach any Gauntlet agent — the same agent specs
 * `gauntlet run` takes — to the vendored 2048 page through the overlay's own
 * injection path, one move at a time, refereed by `gauntlet/bridge`. This is
 * the engine behind the `gauntlet page` subcommand; `cli/page.js` resolves the
 * agent spec and writes the bundle, this module owns the browser.
 *
 * Two agent kinds:
 *
 * - **In-page baselines** (`baseline:2048:greedy|engine`): the page imports
 *   the baseline from the vendored Gauntlet package itself — the same
 *   choreography as `harness.mjs`'s `runBrowserSession`.
 * - **A Node-side agent** (`random`, `model:<provider>/<model>`, dry-run
 *   scripted agents): a proxy whose `act(ctx)` forwards the turn context over
 *   Playwright's `page.exposeFunction` to this process — the exact mechanism
 *   of `model-session.mjs`. The page needs no CORS access to anything, and
 *   every turn is recorded here with its latency; model agents record their
 *   usage too.
 *
 * The attachment choreography (bookmarklet, runtime takeover, documented
 * overlay shims) and the timeout discipline (the session-driving evaluate
 * runs detached and is raced against the report channel and the timeout, so
 * a stalled agent settles the caller at `timeoutMs` and cleanup closes the
 * context) are exactly `model-session.mjs`'s — see its header comment and the
 * README. This module only generalizes which agent sits behind
 * `driver.setSolverEngine`.
 *
 * The module lives in the nested browser package on purpose: `playwright` is
 * resolvable from here (`bridge/browser/node_modules`) and from nowhere else,
 * so the main package stays dependency-free and the CLI loads this file only
 * for the `page` subcommand.
 *
 * @module
 */

import { latencyStats, newSessionContext, parseBookmarklet, takeoverRuntime } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Launch headless Chromium with Playwright from the nested package, turning
 * the two ordinary failure modes — the package missing, the browser binary
 * missing — into a message that names the install command instead of a stack
 * trace.
 *
 * @param {{ headless?: boolean }} [options]
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromium(options = {}) {
  /** @type {typeof import('playwright')} */
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (err) {
    throw new Error(
      [
        'gauntlet page needs Playwright, which lives in the nested browser package',
        '(gauntlet/bridge/browser) so the main Gauntlet package stays dependency-free.',
        'Install it with:',
        '  cd gauntlet/bridge/browser && npm ci && npx playwright install chromium',
        `The import failed with: ${err instanceof Error ? err.message : String(err)}`,
      ].join('\n'),
    );
  }
  try {
    return await playwright.chromium.launch({
      headless: options.headless ?? true,
      chromiumSandbox: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch|Playwright was just installed|Host system is missing/i.test(message)) {
      throw new Error(
        [
          'gauntlet page could not launch Chromium. Install the browser binary,',
          'and the system libraries on a fresh machine, with:',
          '  cd gauntlet/bridge/browser && npx playwright install chromium',
          '  cd gauntlet/bridge/browser && npx playwright install-deps chromium',
          `The launch failed with: ${message}`,
        ].join('\n'),
      );
    }
    throw err;
  }
}

/**
 * @typedef {object} PageTurnRecord
 * @property {number} turn Zero-based agent-call index (one per driver step,
 *   Node-side agents only — in-page baselines make no calls through Node).
 * @property {number} ms Wall time of the agent call in this Node process.
 * @property {number | null} inputTokens usage.inputTokens as the agent
 *   reported; null when absent or unreported — a provider that did not
 *   measure a count did not measure it, and 0 would read as measured.
 * @property {number | null} outputTokens usage.outputTokens as reported;
 *   null when unknown, same rule as inputTokens.
 * @property {number | null} retries Transport retries the agent's provider
 *   client needed; the client attaches the count it performed to every throw
 *   (retryError in harness/model-agent.js), so a failed turn records the real
 *   count — null only when a throw carries none (and for agents with no
 *   provider at all, like `random`).
 * @property {string | null} responseId The server's response id, when sent.
 * @property {number} reasoningChars Reasoning delivered separately (count only).
 * @property {number} replyChars Length of the reply text the runner parses.
 * @property {string} [error] When the agent call failed: the transport error.
 *   The turn then counts as an invalid attempt (empty reply), exactly like an
 *   offline transport failure in the harness.
 */

/**
 * @typedef {object} PageSessionReport
 * @property {string} adapterName The overlay adapter the runtime attached.
 * @property {number} preMoves Moves the overlay's own auto-play loop made
 *   before takeover.
 * @property {'game-over' | 'move-cap' | string} endedWhy
 * @property {number} moves Successful, refereed moves.
 * @property {number} diverged Steps where the applied direction differs from
 *   the agent's chosen one (the driver's designed fall-through).
 * @property {number} fallbacks Steps where the agent produced no usable
 *   action and the driver played its own fallback order (chosen === null).
 * @property {*} log The playkit-gauntlet-bridge-log/1 session log.
 * @property {number[]} perMoveMs Per-move wall time around driver.step().
 * @property {number | null} finalScore The page score at the end.
 * @property {string} userAgent
 * @property {PageTurnRecord[]} turns One record per Node-side agent call
 *   (empty for in-page baselines).
 * @property {{ errorTurns: number, modelLatencyMs: { mean: number, p50: number, p95: number, max: number }, totalPromptTokens: number | 'unknown', totalCompletionTokens: number | 'unknown' }} accounting
 *   The pure reduction over `turns` — token totals are 'unknown' when any
 *   turn's count is unknown; unknown stays unknown, never folded into 0.
 */

/**
 * Play one page session in real Chromium on the vendored page.
 *
 * @param {object} setup
 * @param {import('playwright').Browser} setup.browser Launched Chromium.
 * @param {number} setup.port Fixture server port.
 * @param {{ mode: 'in-page', name: 'greedy' | 'engine' } | { mode: 'node', agent: * }} setup.agent
 *   Which agent plays: an in-page baseline, or a Node-side Gauntlet agent
 *   instance (from `cli/agents.js` — a model agent, `random`, or a scripted
 *   dry-run agent) proxied over `page.exposeFunction`.
 * @param {number} [setup.maxMoves] Session move cap (default 150).
 * @param {string} [setup.urlPath] Page to open (default `/2048/`; use
 *   `/2048-faulty/` for the tampered copy).
 * @param {number} [setup.seed] Pin the page's Math.random (reproducible runs).
 * @param {number} [setup.timeoutMs] Session timeout (default 600000).
 * @returns {Promise<PageSessionReport>}
 */
export async function runPageSession(setup) {
  const { browser, port, agent } = setup;
  if (!agent || (agent.mode !== 'in-page' && agent.mode !== 'node')) {
    throw new Error('runPageSession: agent must be { mode: "in-page", name } or { mode: "node", agent }');
  }
  if (agent.mode === 'node' && typeof agent.agent?.act !== 'function') {
    throw new Error('runPageSession: agent { mode: "node" } needs a Gauntlet agent instance with act(ctx)');
  }
  const maxMoves = setup.maxMoves ?? 150;
  const urlPath = setup.urlPath ?? '/2048/';
  const timeoutMs = setup.timeoutMs ?? 600000;

  /** @type {PageTurnRecord[]} */
  const agentTurns = [];

  const context = await newSessionContext(browser, { seed: setup.seed });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let sessionTimer;
  try {
    const page = await context.newPage();

    /** The result channel back to Node. */
    /** @type {(value: *) => void} */
    let resolveReport;
    const reported = new Promise((resolvePromise) => {
      resolveReport = resolvePromise;
    });
    // Same timeout discipline as runBrowserSession and runBrowserModelSession:
    // race the timeout immediately, consume its rejection eagerly, clear the
    // timer in finally.
    const timeout = new Promise((_, rejectTimeout) => {
      sessionTimer = setTimeout(
        () => rejectTimeout(new Error(`page session timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof sessionTimer.unref === 'function') sessionTimer.unref();
    });
    const reportPromise = Promise.race([reported, timeout]);
    reportPromise.catch(() => {});

    // The Node-side agent call channel — the page proxy's act() hands the
    // TurnContext to this handler and returns the reply. Registered before
    // page scripts run. Harmless (unused) for in-page baselines.
    await page.exposeFunction('__gauntletAgentTurn', async (ctx) => {
      const nodeAgent = agent.mode === 'node' ? agent.agent : null;
      const turn = agentTurns.length;
      const t0 = performance.now();
      try {
        const reply = await nodeAgent.act(ctx);
        const ms = performance.now() - t0;
        agentTurns.push({
          turn,
          ms,
          inputTokens: reply.usage && typeof reply.usage.inputTokens === 'number' ? reply.usage.inputTokens : null,
          outputTokens: reply.usage && typeof reply.usage.outputTokens === 'number' ? reply.usage.outputTokens : null,
          retries: reply.meta && typeof reply.meta.retries === 'number' ? reply.meta.retries : null,
          responseId: reply.meta && typeof reply.meta.responseId === 'string' ? reply.meta.responseId : null,
          reasoningChars: reply.meta && typeof reply.meta.reasoningChars === 'number' ? reply.meta.reasoningChars : 0,
          replyChars: typeof reply.text === 'string' ? reply.text.length : 0,
        });
        return reply;
      } catch (err) {
        // A failed agent call becomes an empty reply: the driver falls back
        // and the step is recorded with chosen === null, which is exactly how
        // an unusable reply is recorded. The session continues instead of
        // dying on transport.
        const ms = performance.now() - t0;
        const reason = err instanceof Error ? err.message : String(err);
        // The provider client attaches the retries it performed to every
        // throw (retryError in harness/model-agent.js) — record the real
        // count, 0 when the first answer was not retryable, null only when a
        // throw carries no count at all.
        const retries =
          err !== null && typeof err === 'object' && typeof /** @type {*} */ (err).retries === 'number'
            ? /** @type {*} */ (err).retries
            : null;
        agentTurns.push({ turn, ms, inputTokens: null, outputTokens: null, retries, responseId: null, reasoningChars: 0, replyChars: 0, error: reason });
        return { text: '', usage: null, meta: { retries } };
      }
    });

    // The result channel back to Node — the same contract the other sessions
    // use; the page-side evaluate below resolves it when the session ends.
    await page.exposeFunction('__bridgeReport', (value) => resolveReport(value));

    await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
    // The page constructs the game inside requestAnimationFrame — wait for it.
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, {
      timeout: 15000,
      polling: 100,
    });
    // The overlay build defect's documented workaround (see harness.mjs and
    // the README): expose the real adapter registry from the unmodified
    // sources via native ESM.
    await page.evaluate(async () => {
      const adapters = await import('/src/adapters/index.js');
      window.globalAdapterRegistry = adapters.globalAdapterRegistry;
    });
    // Attach the way a user does: paste the bookmarklet.
    const loaderSource = await readFile(
      resolve(thisDir, '..', '..', '..', 'src', 'bookmarklet', 'loader.js'),
      'utf8',
    );
    await page.evaluate(parseBookmarklet(loaderSource, port));
    await page.waitForFunction(() => Boolean(window.ai2048Runtime), null, {
      timeout: 20000,
      polling: 100,
    });

    const attachInfo = await takeoverRuntime(page);

    // The session-driving evaluate is awaited detached, never directly — the
    // same reasoning as model-session.mjs: a Node-side agent whose provider
    // stalls can wedge the evaluate forever, and only the race below makes
    // timeoutMs real. A genuine evaluate failure still propagates.
    const evalPromise = page.evaluate(
      async ({ mode, inPageName, agentId, agentTrack, moves }) => {
        const rt = /** @type {*} */ (window).ai2048Runtime;
        const { playBridgeSession } = await import('/gauntlet/bridge/session.js');

        /** @type {*} */
        let sessionAgent;
        if (mode === 'in-page') {
          const baselines = await import('/gauntlet/games/2048/baselines.js');
          sessionAgent = inPageName === 'engine' ? baselines.engine({ depth: 2 }) : baselines.greedy();
        } else {
          sessionAgent = {
            id: agentId,
            track: agentTrack,
            async act(ctx) {
              return /** @type {*} */ (window).__gauntletAgentTurn(ctx);
            },
          };
        }

        // Instrument the real driver.step for per-move wall time only.
        const perMoveMs = [];
        const realStep = rt.driver.step.bind(rt.driver);
        rt.driver.step = async () => {
          const t0 = performance.now();
          try {
            return await realStep();
          } finally {
            perMoveMs.push(performance.now() - t0);
          }
        };

        const result = await playBridgeSession(
          { adapter: rt.currentAdapter, driver: rt.driver, agent: sessionAgent },
          { maxMoves: moves },
        );
        const score = rt.currentAdapter.getScore();
        window.__bridgeReport({
          adapterName: rt.currentAdapter.getName(),
          preMoves: 0,
          endedWhy: result.endedWhy,
          moves: result.moves,
          diverged: result.diverged,
          log: result.log,
          perMoveMs,
          finalScore: typeof score === 'number' ? score : null,
          userAgent: navigator.userAgent,
        });
      },
      {
        mode: agent.mode,
        inPageName: agent.mode === 'in-page' ? agent.name : null,
        agentId: agent.mode === 'node' ? String(agent.agent.id ?? 'node-agent') : null,
        agentTrack: agent.mode === 'node' ? String(agent.agent.track ?? 'official') : null,
        moves: maxMoves,
      },
    );
    evalPromise.catch(() => {});
    const report = await Promise.race([reportPromise, evalPromise]);
    const steps = report.log.steps;
    const fallbacks = steps.filter((/** @type {*} */ s) => s.chosen === null).length;
    return {
      ...report,
      preMoves: attachInfo.preMoves,
      adapterName: attachInfo.adapterName,
      fallbacks,
      turns: agentTurns,
      accounting: summarizeAgentTurns(agentTurns),
    };
  } finally {
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
    await context.close();
  }
}

/**
 * Pure reduction over the recorded agent turns — the same shape as
 * `summarizeModelTurns` in model-session.mjs, shared by `gauntlet page`'s
 * bundle accounting. Exported so the suite can test it offline.
 *
 * @param {PageTurnRecord[]} agentTurns
 * @returns {{ errorTurns: number, modelLatencyMs: { mean: number, p50: number, p95: number, max: number }, totalPromptTokens: number | 'unknown', totalCompletionTokens: number | 'unknown' }}
 */
export function summarizeAgentTurns(agentTurns) {
  const completed = agentTurns.filter((t) => t.error === undefined);
  // A turn with a null token count (no provider, usage omitted, or the count
  // unreported) makes the total unknown: summing only the known turns would
  // print a partial number that reads as complete, and treating null as 0
  // would print a measured-looking total for an unmeasured session.
  const sumTokens = (/** @type {'inputTokens' | 'outputTokens'} */ key) =>
    agentTurns.every((t) => typeof t[key] === 'number')
      ? agentTurns.reduce((a, t) => a + /** @type {number} */ (t[key]), 0)
      : 'unknown';
  return {
    errorTurns: agentTurns.length - completed.length,
    modelLatencyMs: latencyStats(completed.map((t) => t.ms)),
    totalPromptTokens: sumTokens('inputTokens'),
    totalCompletionTokens: sumTokens('outputTokens'),
  };
}

/**
 * The bundle file stem for a page session log: the seed when pinned, else a
 * timestamp (an unseeded page is the page's own randomness, so two unseeded
 * sessions must not overwrite one another). Unsafe characters are replaced,
 * never interpreted.
 *
 * @param {number | undefined} seed
 * @returns {string}
 */
export function pageLogName(seed) {
  if (seed === undefined || seed === null) {
    return `unseeded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const safe = String(seed).replace(/[^A-Za-z0-9._-]+/g, '-');
  return safe.length > 0 ? safe : 'seed';
}

export {};
