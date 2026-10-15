import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

import {
  ensureBookmarkletBundle,
  parseBookmarklet,
  runBrowserSession,
  latencyStats,
  newSessionContext,
  takeoverRuntime,
} from './harness.mjs';
import { startFixtureServer } from './server.mjs';
import { runBrowserModelSession, modelSessionSummary } from './model-session.mjs';
import { verifyBridgeLog } from '../session-log.js';
import { maxTile } from '../../games/2048/rules.js';

/** Shared fixture state: one server, one browser, per-test pages. */
let server;
let browser;
let port;
let bookmarkletCode;

before(async () => {
  // The repo's own bundler builds dist/2048-hud.min.js from src/runtime/bookmarklet.js.
  await ensureBookmarkletBundle();
  server = await startFixtureServer();
  port = server.port;
  const loaderSource = await readFile(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'src', 'bookmarklet', 'loader.js'),
    'utf8',
  );
  // Fail fast if the loader no longer looks like the bookmarklet this harness pastes.
  bookmarkletCode = parseBookmarklet(loaderSource, port);
  browser = await chromium.launch({ headless: true, chromiumSandbox: false });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/**
 * Shared assertions for a clean baseline session: the agent drove the real
 * page through the real adapter and driver, every transition passed the
 * referee, and the whole session log verifies by replay.
 *
 * @param {Awaited<ReturnType<typeof runBrowserSession>>} report
 * @returns {{ summary: object, finalBoard: number[][] }}
 */
function assertCleanSession(report) {
  assert.equal(report.adapterName, 'Play2048Adapter', 'the runtime must attach its Play2048Adapter');
  assert.equal(report.log.format, 'playkit-gauntlet-bridge-log/1');
  assert.ok(report.moves > 0, 'the session must play at least one move');
  assert.equal(report.moves, report.log.steps.length, 'moves and recorded steps agree');
  assert.ok(
    report.endedWhy === 'move-cap' || report.endedWhy === 'game-over',
    `unexpected ending: ${report.endedWhy}`,
  );

  for (const step of report.log.steps) {
    assert.equal(step.verdict.ok, true, `referee rejected move ${step.turn}: ${step.verdict.reason}`);
    assert.notEqual(step.applied, null);
  }
  const verified = verifyBridgeLog(report.log);
  assert.equal(verified.ok, true, verified.ok ? '' : `log replay failed at step ${verified.index}: ${verified.reason}`);
  const last = report.log.steps[report.log.steps.length - 1];
  if (verified.ok) {
    assert.deepEqual(verified.finalBoard, last.boardAfter);
  }

  const lat = latencyStats(report.perMoveMs);
  const summary = {
    agent: report.log.agent.id,
    moves: report.moves,
    endedWhy: report.endedWhy,
    diverged: report.diverged,
    divergedShare: `${((100 * report.diverged) / report.moves).toFixed(1)}%`,
    refereeRejections: report.log.steps.filter((s) => !s.verdict.ok).length,
    finalScore: report.finalScore,
    finalMaxTile: maxTile(last.boardAfter),
    perMoveMs: {
      mean: Number(lat.mean.toFixed(1)),
      p50: Number(lat.p50.toFixed(1)),
      p95: Number(lat.p95.toFixed(1)),
      max: Number(lat.max.toFixed(1)),
    },
    userAgent: report.userAgent,
  };
  return { summary, finalBoard: verified.ok ? verified.finalBoard : last.boardAfter };
}

test('greedy baseline plays the vendored 2048 page in real Chromium through the bookmarklet runtime, refereed move by move', { timeout: 420000 }, async () => {
  // Greptile P2 #4285440512: the length floor used to sit on unseeded spawns,
  // so a legitimately short game (game-over before 150 moves, likeliest with
  // the greedy agent) failed the test without any bridge defect. The session
  // RNG is pinned now, and seed 11111 reproducibly caps the greedy agent at
  // the 150-move floor (verified at fix time: 150 moves, move-cap, score
  // 14768), so the assertion below checks a reproducible fact.
  const report = await runBrowserSession({ browser, port, agent: 'greedy', maxMoves: 200, seed: 11111 });
  const { summary } = assertCleanSession(report);
  console.log('[bridge-browser] session summary:', JSON.stringify(summary));
  assert.ok(summary.moves >= 150, `expected a long session, stopped at ${summary.moves} (${summary.endedWhy})`);
});

test('expectimax engine baseline plays the vendored 2048 page in real Chromium through the bookmarklet runtime, refereed move by move', { timeout: 420000 }, async () => {
  // Greptile P2 #4285440512: pinned like the greedy session — seed 11111
  // reproducibly caps the expectimax agent past the 150-move floor (verified
  // at fix time: 150 moves, move-cap, score 1452).
  const report = await runBrowserSession({ browser, port, agent: 'engine', maxMoves: 200, seed: 11111 });
  const { summary } = assertCleanSession(report);
  console.log('[bridge-browser] session summary:', JSON.stringify(summary));
  assert.ok(summary.moves >= 150, `expected a long session, stopped at ${summary.moves} (${summary.endedWhy})`);
});

test('takeover waits for an in-flight automatic move, so no unrecorded move plays beside the session', { timeout: 180000 }, async () => {
  // Greptile P1 #4285440447: rt.stop() (the driver's stop()) only flips flags;
  // a tick already inside await this.executeMove() keeps running, and its DOM
  // write can land after takeover — an unrecorded move beside the first
  // Gauntlet step, or a referee rejection of a clean page. Deterministic with
  // a slow stub solver: the auto-play loop's next move stalls in flight, and
  // takeover must not return until that move has settled and no further
  // automatic move lands.
  const context = await newSessionContext(browser, {});
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/2048/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, {
      timeout: 15000,
      polling: 100,
    });
    await page.evaluate(async () => {
      const adapters = await import('/src/adapters/index.js');
      window.globalAdapterRegistry = adapters.globalAdapterRegistry;
    });
    await page.evaluate(bookmarkletCode);
    await page.waitForFunction(() => Boolean(window.ai2048Runtime), null, {
      timeout: 20000,
      polling: 100,
    });

    // Replace the auto-play move with a slow stub, then wait until it is
    // mid-move — the takeover must happen with a move in flight. Like the
    // real executeMove, the stub increments driver.moveCount on success:
    // that counter is the observable state the takeover drains on.
    await page.evaluate(() => {
      const rt = /** @type {*} */ (window).ai2048Runtime;
      const driver = rt.driver;
      window.__moveProbe = { started: 0, finished: 0, inFlight: false, moveCount: driver.getStats().moveCount };
      driver.executeMove = async () => {
        const probe = window.__moveProbe;
        probe.started += 1;
        probe.inFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
        probe.moveCount += 1;
        driver.moveCount += 1;
        probe.finished += 1;
        probe.inFlight = false;
        return true;
      };
    });
    await page.waitForFunction(() => window.__moveProbe.inFlight === true, null, {
      timeout: 15000,
      polling: 25,
    });

    await takeoverRuntime(page);

    const probe = await page.evaluate(() => window.__moveProbe);
    assert.equal(
      probe.inFlight,
      false,
      'takeover must return only after the in-flight automatic move settled',
    );
    assert.equal(probe.finished, probe.started, 'every started move must have finished');
    const after = await page.evaluate(() => window.__moveProbe.moveCount);
    await page.waitForTimeout(500);
    const settled = await page.evaluate(() => window.__moveProbe.moveCount);
    assert.equal(settled, after, 'no further automatic move may land after takeover');
  } finally {
    await context.close();
  }
});

test('a session that never reports times out, reaches cleanup, and raises no unhandled rejection', { timeout: 120000 }, async () => {
  // Greptile P2 #4285440537: the timeout used to reject a promise that nothing
  // consumed until the page work finished, so a session whose report never
  // arrived produced an unhandled rejection (skipping cleanup) and the timer
  // outlived successful runs. A tiny timeout against a healthy page forces the
  // timeout path deterministically: the rejection must surface here as the
  // session's own timeout error, the browser context must be closed, and no
  // unhandled rejection may fire.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runBrowserSession({ browser, port, agent: 'greedy', maxMoves: 1, timeoutMs: 250 }),
      /timed out/,
      'the timeout must reject the session promise itself',
    );
    assert.equal(browser.contexts().length, 0, 'the session context must be closed after the timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(unhandled, [], 'the timeout must not surface as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a copy of the vendored game that merges a tile twice in one move is flagged on its first offending move and the session stops with that reason', { timeout: 420000 }, async () => {
  // Pinned page RNG: the tampered run is fully reproducible, so "first
  // offending move" is a fixed, observable transition.
  const report = await runBrowserSession({
    browser,
    port,
    agent: 'greedy',
    maxMoves: 200,
    urlPath: '/2048-faulty/',
    seed: 987654321,
  });

  assert.equal(report.adapterName, 'Play2048Adapter');
  assert.match(report.endedWhy, /^referee: /, `session must stop at the referee, got: ${report.endedWhy}`);
  const offending = report.log.steps[report.log.steps.length - 1];
  assert.equal(offending.verdict.ok, false, 'the last recorded move is the first offending one');
  // A double-merge cascade typically produces a board no single slide can
  // explain (verdict.applied === null); a settled-cell violation keeps the
  // slide with diverged === true. Both are rejections — require the reason.
  assert.ok(
    offending.verdict.reason,
    `the offending verdict carries a reason (applied=${offending.verdict.applied}, diverged=${offending.verdict.diverged})`,
  );
  assert.notEqual(offending.boardBefore, null);
  assert.notEqual(offending.boardAfter, null);
  for (const step of report.log.steps.slice(0, -1)) {
    assert.equal(step.verdict.ok, true, 'every move before the offending one must have passed the referee');
  }
  assert.equal(report.moves, report.log.steps.length);

  const verified = verifyBridgeLog(report.log);
  assert.equal(verified.ok, false, 'the tampered log must fail replay verification');
  if (!verified.ok) {
    assert.equal(verified.index, report.log.steps.length - 1, 'replay fails exactly at the offending move');
  }

  const summary = {
    agent: report.log.agent.id,
    endedWhy: report.endedWhy,
    offendingMove: offending.turn,
    chosen: offending.chosen,
    boardBefore: offending.boardBefore,
    boardAfter: offending.boardAfter,
    refereeReason: offending.verdict.reason,
    refereeApplied: offending.verdict.applied,
    refereeDiverged: offending.verdict.diverged,
    replayCheck: verified.ok ? 'passed' : `failed at step ${verified.index}: ${verified.reason}`,
  };
  console.log('[bridge-browser] fault-check summary:', JSON.stringify(summary));
  assert.ok(
    summary.offendingMove <= 150,
    `the tamper should surface within a bounded session, got move ${summary.offendingMove}`,
  );
});

// ---------------------------------------------------------------------------
// Model sessions: a language model chooses every move on the live page.
//
// The model call runs in Node (`page.exposeFunction`), never in the page: the
// page-side agent is a proxy over the Node-side official-track agent
// (`harness/model-agent.js`, provider "openai-chat"), so the page needs no
// CORS access to the model server and every call is logged with its usage.
// See model-session.mjs.

/** Recorded real-model session log: the offline fixture (committed). */
const MODEL_LOG_FIXTURE = new URL('./fixtures/model-session-2048.json', import.meta.url);

test('a recorded real-model bridge session log replays through verifyBridgeLog (offline fixture, no network)', async () => {
  const fixture = JSON.parse(await readFile(MODEL_LOG_FIXTURE, 'utf8'));
  assert.equal(fixture.format, 'playkit-gauntlet-bridge-log/1');
  // The fixture is a real recorded run of the model agent on the page, not a
  // synthetic log: the agent id names the provider/model that played it, and
  // it has substance (a bounded live run, not one or two moves).
  assert.match(fixture.agent.id, /^openai-chat\//, 'the fixture must be a model-agent session');
  assert.match(fixture.agent.track, /^official$/);
  assert.ok(fixture.steps.length >= 20, `the fixture must be a real session, got ${fixture.steps.length} steps`);
  assert.ok(fixture.ended, 'the fixture must be a finished session');
  assert.equal(
    fixture.ended.turn,
    fixture.steps.length,
    'the recorded ending turn agrees with the recorded steps',
  );

  // Replay verification re-derives every transition from the rules (the same
  // check every live session report goes through).
  const verified = verifyBridgeLog(fixture);
  assert.equal(
    verified.ok,
    true,
    verified.ok ? '' : `fixture replay failed at step ${verified.index}: ${verified.reason}`,
  );
  if (verified.ok) {
    assert.deepEqual(verified.finalBoard, fixture.steps[fixture.steps.length - 1].boardAfter);
  }
});

const CHAT_URL_ENV = 'GAUNTLET_LOCAL_CHAT_URL';
const CHAT_MODEL_ENV = 'GAUNTLET_LOCAL_CHAT_MODEL';
const liveBaseUrl = process.env[CHAT_URL_ENV];
const liveModel = process.env[CHAT_MODEL_ENV];
const liveOptIn =
  typeof liveBaseUrl === 'string' &&
  liveBaseUrl.length > 0 &&
  typeof liveModel === 'string' &&
  liveModel.length > 0;
const liveSkipReason =
  `opt-in: set ${CHAT_URL_ENV} and ${CHAT_MODEL_ENV} to run a real local ` +
  'OpenAI-compatible chat server through the live page (see harness/PROVIDERS.md)';

if (liveOptIn) {
  test('a local model chooses every move for the overlay driver on the clean page; every transition is refereed and the log verifies', { timeout: 1200000 }, async () => {
    const report = await runBrowserModelSession({
      browser,
      port,
      baseUrl: liveBaseUrl,
      model: liveModel,
      maxMoves: 150,
    });
    assert.equal(report.adapterName, 'Play2048Adapter');
    assert.equal(report.moves, report.log.steps.length);
    assert.ok(
      report.endedWhy === 'move-cap' || report.endedWhy === 'game-over',
      `unexpected ending: ${report.endedWhy}`,
    );
    for (const step of report.log.steps) {
      assert.equal(step.verdict.ok, true, `referee rejected move ${step.turn}: ${step.verdict.reason}`);
    }
    const verified = verifyBridgeLog(report.log);
    assert.equal(
      verified.ok,
      true,
      verified.ok ? '' : `log replay failed at step ${verified.index}: ${verified.reason}`,
    );
    // The model must actually be making the calls: at least one per move.
    assert.ok(
      report.modelTurns.length >= report.moves,
      `expected at least ${report.moves} model calls, got ${report.modelTurns.length}`,
    );
    // Fallbacks (moves the driver played that the model did not choose) are
    // the honest failure mode of a small model; report them loudly and bound
    // them so the test stays meaningful.
    assert.ok(
      report.fallbacks <= 10,
      `too many fallback moves (${report.fallbacks}/${report.moves}); see the summary`,
    );
    console.log('[bridge-browser] model session summary:', JSON.stringify(modelSessionSummary(report)));
  });

  test('a local model on the tampered copy is flagged by the referee on its first offending move, like the baselines', { timeout: 1200000 }, async () => {
    const report = await runBrowserModelSession({
      browser,
      port,
      baseUrl: liveBaseUrl,
      model: liveModel,
      maxMoves: 150,
      urlPath: '/2048-faulty/',
    });
    assert.match(report.endedWhy, /^referee: /, `session must stop at the referee, got: ${report.endedWhy}`);
    const offending = report.log.steps[report.log.steps.length - 1];
    assert.equal(offending.verdict.ok, false, 'the last recorded move is the first offending one');
    for (const step of report.log.steps.slice(0, -1)) {
      assert.equal(step.verdict.ok, true, 'every move before the offending one must have passed the referee');
    }
    const verified = verifyBridgeLog(report.log);
    assert.equal(verified.ok, false, 'the tampered log must fail replay verification');
    if (!verified.ok) {
      assert.equal(verified.index, report.log.steps.length - 1, 'replay fails exactly at the offending move');
    }
    console.log(
      '[bridge-browser] model fault-check summary:',
      JSON.stringify({ ...modelSessionSummary(report), refereeReason: offending.verdict.reason }),
    );
  });
} else {
  test('live model sessions on the page (opt-in)', { skip: liveSkipReason }, async () => {
    assert.fail('unreachable: the test only runs when opted in');
  });
}
