/**
 * A model bridge session: a language model drives one live 2048 page through
 * the overlay's own injection path, one move at a time, refereed by
 * `gauntlet/bridge` — the same choreography as the baseline sessions in
 * `harness.mjs`, with `harness/model-agent.js` (`provider: "openai-chat"`)
 * choosing every move.
 *
 * The model call runs in Node, never in the page: the page-side agent is a
 * proxy whose `act(ctx)` forwards the turn context over Playwright's
 * `page.exposeFunction` channel to this process, where `createModelAgent` —
 * the same official-track agent the headless harness uses — builds the
 * official turn message, calls the OpenAI-compatible chat-completions server
 * on 127.0.0.1, and records usage. The page therefore needs no CORS access to
 * the model server and every call is logged with its token usage; the reply
 * text travels back and is parsed by the overlay path exactly like any
 * official-track reply (`extractAction` → `game.parseAction` → direction
 * order). The proxy agent's `id`/`track` match the Node agent, so the session
 * log records the real model identity.
 *
 * Attachment choreography and the documented overlay shims (no-touch profile,
 * HUD pause/resume no-ops, native-ESM adapter registry, quiesced auto-play)
 * are exactly `harness.mjs`'s — see its header comment and the README; this
 * module only replaces which agent sits behind `driver.setSolverEngine`.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelAgent } from '../../harness/model-agent.js';
import { latencyStats, newSessionContext, parseBookmarklet, takeoverRuntime } from './harness.mjs';

const thisDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * @typedef {object} ModelTurnRecord
 * @property {number} turn Zero-based model-call index (one per driver step).
 * @property {number} ms Wall time of the model call in this Node process.
 * @property {number | null} inputTokens usage.prompt_tokens as the server
 *   reported; null when the agent's usage was absent or the count null — a
 *   provider that omitted a count did not measure it, and 0 would read as
 *   measured.
 * @property {number | null} outputTokens usage.completion_tokens as reported;
 *   null when unknown, same rule as inputTokens.
 * @property {number | null} retries Transport retries the provider client
 *   needed; null means unknown. The client attaches the count it performed to
 *   every throw (retryError in harness/model-agent.js), so a failed turn
 *   records the real count — 0 when the first answer was not retryable, the
 *   exhausted count when retries ran out — and null only when a throw carries
 *   no count at all.
 * @property {string | null} responseId The server's response id, when sent.
 * @property {number} reasoningChars Reasoning delivered separately (count only).
 * @property {number} replyChars Length of the reply text the runner parses.
 * @property {string} [error] When the model call failed after retries: the
 *   transport error. The turn then counts as an invalid attempt (empty reply),
 *   exactly like an offline transport failure in the harness.
 */

/**
 * @typedef {object} ModelSessionReport
 * @property {string} adapterName The overlay adapter the runtime attached.
 * @property {number} preMoves Moves the overlay's own auto-play loop made
 *   before takeover.
 * @property {'game-over' | 'move-cap' | string} endedWhy
 * @property {number} moves Successful, refereed moves.
 * @property {number} diverged Steps where the applied direction differs from
 *   the model's chosen one (the driver's designed fall-through when the
 *   chosen direction does not change the board).
 * @property {number} fallbacks Steps where the model produced no usable
 *   action and the driver played its own fallback order (chosen === null).
 * @property {number} errorTurns Model calls that failed after retries.
 * @property {*} log The playkit-gauntlet-bridge-log/1 session log.
 * @property {number[]} perMoveMs Per-move wall time around driver.step().
 * @property {number | null} finalScore The page score at the end.
 * @property {string} userAgent
 * @property {{ provider: 'openai-chat', model: string, baseUrl: string }} modelAgent Identity of the agent that played.
 * @property {ModelTurnRecord[]} modelTurns One record per model call.
 * @property {{ mean: number, p50: number, p95: number, max: number }} modelLatencyMs Latency over the model calls that completed.
 * @property {number | 'unknown'} totalPromptTokens Sum of reported prompt
 *   tokens, or 'unknown' when any turn's count is unknown — unknown stays
 *   unknown; it is never folded into 0.
 * @property {number | 'unknown'} totalCompletionTokens Same rule as
 *   totalPromptTokens.
 */

/**
 * Play one model bridge session in real Chromium on the vendored page.
 *
 * @param {object} setup
 * @param {import('playwright').Browser} setup.browser Launched Chromium.
 * @param {number} setup.port Fixture server port.
 * @param {string} setup.baseUrl Root of the OpenAI-compatible chat server on
 *   127.0.0.1 (the client appends /v1/chat/completions).
 * @param {string} setup.model Model label sent to the server and recorded.
 * @param {string} [setup.apiKeyEnv] Name of an env var holding an API key;
 *   unset means no Authorization header (local servers need none).
 * @param {number} [setup.maxOutputTokens] Per-reply cap (default 512, like
 *   the harness's live test — small local models can ramble).
 * @param {number} [setup.maxMoves] Session move cap (default 150).
 * @param {string} [setup.urlPath] Page to open (default `/2048/`; use
 *   `/2048-faulty/` for the tampered copy).
 * @param {number} [setup.seed] Pin the page's Math.random (reproducible runs).
 * @param {number} [setup.timeoutMs] Session timeout (default 600000 — model
 *   calls at ~1 s/move make this an order of magnitude over the baselines').
 * @returns {Promise<ModelSessionReport>}
 */
export async function runBrowserModelSession(setup) {
  const { browser, port, baseUrl, model } = setup;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('runBrowserModelSession: baseUrl (the OpenAI-compatible chat server root) is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('runBrowserModelSession: model is required');
  }
  const maxMoves = setup.maxMoves ?? 150;
  const urlPath = setup.urlPath ?? '/2048/';
  const timeoutMs = setup.timeoutMs ?? 600000;
  const maxOutputTokens = setup.maxOutputTokens ?? 512;

  /** The official-track agent, called only from Node (see module doc). */
  const nodeAgent = createModelAgent({
    provider: 'openai-chat',
    model,
    baseUrl,
    apiKeyEnv: setup.apiKeyEnv,
    maxOutputTokens,
  });

  /** @type {ModelTurnRecord[]} */
  const modelTurns = [];

  const context = await newSessionContext(browser, { seed: setup.seed });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let sessionTimer;
  try {
    const page = await context.newPage();

    /** The result channel back to Node. */
    /** @type {(value: ModelSessionReport) => void} */
    let resolveReport;
    const reported = new Promise((resolvePromise) => {
      resolveReport = resolvePromise;
    });
    // Same timeout discipline as runBrowserSession (Greptile P2 #4285440537):
    // race the timeout immediately, consume its rejection eagerly, clear the
    // timer in finally.
    const timeout = new Promise((_, rejectTimeout) => {
      sessionTimer = setTimeout(
        () => rejectTimeout(new Error(`model bridge session timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof sessionTimer.unref === 'function') sessionTimer.unref();
    });
    const reportPromise = Promise.race([reported, timeout]);
    reportPromise.catch(() => {});

    // The Node-side model call channel. Must exist before page scripts run.
    await page.exposeFunction('__modelTurn', async (ctx) => {
      const turn = modelTurns.length;
      const t0 = performance.now();
      try {
        const reply = await nodeAgent.act(ctx);
        const ms = performance.now() - t0;
        modelTurns.push({
          turn,
          ms,
          inputTokens: reply.usage && typeof reply.usage.inputTokens === 'number' ? reply.usage.inputTokens : null,
          outputTokens: reply.usage && typeof reply.usage.outputTokens === 'number' ? reply.usage.outputTokens : null,
          retries: reply.meta && typeof reply.meta.retries === 'number' ? reply.meta.retries : 0,
          responseId: reply.meta && typeof reply.meta.responseId === 'string' ? reply.meta.responseId : null,
          reasoningChars: reply.meta && typeof reply.meta.reasoningChars === 'number' ? reply.meta.reasoningChars : 0,
          replyChars: typeof reply.text === 'string' ? reply.text.length : 0,
        });
        return reply;
      } catch (err) {
        // A model call that failed after retries becomes an empty reply: the
        // driver falls back and the step is recorded with chosen === null,
        // which is exactly how an unusable reply is recorded. The session
        // continues instead of dying on transport.
        const ms = performance.now() - t0;
        const reason = err instanceof Error ? err.message : String(err);
        // The provider throw carries the retries it performed (retryError in
        // harness/model-agent.js) — record the real count. Recording 0 would
        // undercount retries exactly on failing turns, the one place the
        // count matters; null would waste the metadata the client now sends.
        const errRetries =
          err !== null && typeof err === 'object' && typeof /** @type {*} */ (err).retries === 'number'
            ? /** @type {*} */ (err).retries
            : null;
        modelTurns.push({ turn, ms, inputTokens: null, outputTokens: null, retries: errRetries, responseId: null, reasoningChars: 0, replyChars: 0, error: reason });
        return { text: '', usage: null, meta: { retries: errRetries } };
      }
    });

    // The result channel back to Node — the same contract runBrowserSession
    // uses; the page-side evaluate below resolves it when the session ends.
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

    // The session-driving evaluate is awaited detached, never directly. When
    // the model endpoint stalls, playBridgeSession awaits the proxy agent,
    // which awaits the provider fetch — and that fetch has no deadline of its
    // own — so the evaluate can wedge forever. Awaiting it directly would
    // never reach the timeout race below, and the timeout rejection would die
    // in the eager catch: the caller would hang past timeoutMs indefinitely.
    // Raced instead, the timeout settles the caller at timeoutMs; the finally
    // closes the context, and closing the context kills the wedged page. A
    // genuine evaluate failure (page crash, script error) still propagates:
    // the race rejects with it.
    const evalPromise = page.evaluate(
      async ({ agentId, moves }) => {
        const rt = /** @type {*} */ (window).ai2048Runtime;
        const { playBridgeSession } = await import('/gauntlet/bridge/session.js');

        // The page-side model agent: a proxy. act() hands the TurnContext to
        // Node (window.__modelTurn, exposed above) and returns the reply the
        // Node-side official-track agent produced. The overlay path parses it
        // (toSolverEngine → extractAction → parseAction) exactly like any
        // official-track reply.
        const proxyAgent = {
          id: agentId,
          track: 'official',
          provider: 'openai-chat',
          async act(ctx) {
            return /** @type {*} */ (window).__modelTurn(ctx);
          },
        };

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
          { adapter: rt.currentAdapter, driver: rt.driver, agent: proxyAgent },
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
      { agentId: nodeAgent.id, moves: maxMoves },
    );
    evalPromise.catch(() => {});
    // The race is what makes timeoutMs real: the timeout promise was armed at
    // the top of the try, and this is the first await that can deliver its
    // rejection to the caller while the session may still be wedged.
    const report = await Promise.race([reportPromise, evalPromise]);
    const steps = report.log.steps;
    const fallbacks = steps.filter((s) => s.chosen === null).length;
    return {
      ...report,
      preMoves: attachInfo.preMoves,
      adapterName: attachInfo.adapterName,
      fallbacks,
      ...summarizeModelTurns(modelTurns),
      modelAgent: { provider: 'openai-chat', model, baseUrl },
      modelTurns,
    };
  } finally {
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
    await context.close();
  }
}

/**
 * Pure reduction over the recorded model turns: error accounting, latency
 * over the calls that completed, and token totals over every call. Exported
 * so the default suite can test the report logic offline — the Playwright
 * path itself is exercised by the stub-server tests in the suite.
 *
 * @param {ModelTurnRecord[]} modelTurns
 * @returns {{ errorTurns: number, modelLatencyMs: { mean: number, p50: number, p95: number, max: number }, totalPromptTokens: number | 'unknown', totalCompletionTokens: number | 'unknown' }}
 */
export function summarizeModelTurns(modelTurns) {
  const completed = modelTurns.filter((t) => t.error === undefined);
  // A turn with a null token count (usage omitted or the count unreported)
  // makes the total unknown: summing only the known turns would print a
  // partial number that reads as complete, and treating null as 0 would
  // print a measured-looking total for an unmeasured session.
  const sumTokens = (key) =>
    modelTurns.every((t) => typeof t[key] === 'number')
      ? modelTurns.reduce((a, t) => a + t[key], 0)
      : 'unknown';
  return {
    errorTurns: modelTurns.length - completed.length,
    modelLatencyMs: latencyStats(completed.map((t) => t.ms)),
    totalPromptTokens: sumTokens('inputTokens'),
    totalCompletionTokens: sumTokens('outputTokens'),
  };
}

/**
 * Human-readable one-line summary of a model session report, for logs and
 * PR bodies.
 *
 * @param {ModelSessionReport} report
 * @returns {Record<string, *>}
 */
export function modelSessionSummary(report) {
  const finalBoard = report.log.steps.length > 0 ? report.log.steps[report.log.steps.length - 1].boardAfter : report.log.initialBoard;
  return {
    agent: report.log.agent.id,
    moves: report.moves,
    endedWhy: report.endedWhy,
    diverged: report.diverged,
    fallbacks: report.fallbacks,
    errorTurns: report.errorTurns,
    finalScore: report.finalScore,
    finalMaxTile: Math.max(...finalBoard.flat()),
    modelLatencyMs: {
      mean: Number(report.modelLatencyMs.mean.toFixed(0)),
      p50: Number(report.modelLatencyMs.p50.toFixed(0)),
      p95: Number(report.modelLatencyMs.p95.toFixed(0)),
      max: Number(report.modelLatencyMs.max.toFixed(0)),
    },
    totalPromptTokens: report.totalPromptTokens,
    totalCompletionTokens: report.totalCompletionTokens,
  };
}

export {};
